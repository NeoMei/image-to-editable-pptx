import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import { inpaintBackground } from "../src/providers/wanx-edit.js";

const PROMPT =
  "移除白色遮罩区域中的文字、图标、线条和面板边框，延续周围米白色纸张纹理与自然阴影，不添加任何新文字、符号、物体或装饰。";

const config: AppConfig = {
  apiKey: "offline-test-key",
  workspaceId: "workspace-123",
  dashscopeApiBase:
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1",
  dashscopeCompatibleBase:
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ocrModel: "qwen3.5-ocr",
  visionModel: "qwen3-vl-plus",
  editModel: "wanx2.1-imageedit",
  requestTimeoutMs: 120_000,
  pollIntervalMs: 0,
};

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function createSuccessfulTaskFetch(
  taskId: string,
  download: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  const resultUrl = `https://temporary-result.example/${taskId}.png`;
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/image-synthesis")) {
      return Response.json({
        request_id: `submit-${taskId}`,
        output: { task_id: taskId, task_status: "PENDING" },
      });
    }
    if (url.endsWith(`/tasks/${taskId}`)) {
      return Response.json({
        request_id: `poll-${taskId}`,
        output: {
          task_id: taskId,
          task_status: "SUCCEEDED",
          results: [{ url: resultUrl }],
        },
        usage: { image_count: 1 },
      });
    }
    assert.equal(url, resultUrl);
    return download(input, init);
  };
}

test("submits masked PNGs, polls pending and running states, then downloads the succeeded image", async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const downloaded = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa]);
  const responses = [
    Response.json({
      request_id: "submit-request",
      output: { task_id: "task-success", task_status: "PENDING" },
    }),
    Response.json({
      request_id: "poll-pending",
      output: { task_id: "task-success", task_status: "PENDING" },
    }),
    Response.json({
      request_id: "poll-running",
      output: { task_id: "task-success", task_status: "RUNNING" },
    }),
    Response.json({
      request_id: "poll-succeeded",
      output: {
        task_id: "task-success",
        task_status: "SUCCEEDED",
        results: [
          {
            url: "https://temporary-result.example/clean.png?Expires=123",
          },
        ],
      },
      usage: { image_count: 1 },
    }),
    new Response(downloaded, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }),
  ];

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    assert.ok(response, `unexpected fetch call to ${String(input)}`);
    return response;
  };

  try {
    const result = await inpaintBackground(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from([0x00, 0xff]),
      config,
    );

    assert.equal(result.taskId, "task-success");
    assert.deepEqual(result.image, downloaded);
    assert.equal(calls.length, 5);
    assert.equal(
      calls[0]?.url,
      "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis",
    );
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(calls[0]?.init?.headers, {
      Authorization: "Bearer offline-test-key",
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    });
    assert.equal(calls[0]?.init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      model: "wanx2.1-imageedit",
      input: {
        function: "description_edit_with_mask",
        prompt: PROMPT,
        base_image_url: "data:image/png;base64,iVBORw==",
        mask_image_url: "data:image/png;base64,AP8=",
      },
      parameters: { n: 1 },
    });

    for (const call of calls.slice(1, 4)) {
      assert.equal(
        call.url,
        "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/tasks/task-success",
      );
      assert.equal(call.init?.method, "GET");
      assert.deepEqual(call.init?.headers, {
        Authorization: "Bearer offline-test-key",
      });
      assert.equal(call.init?.redirect, "error");
    }

    assert.equal(
      calls[4]?.url,
      "https://temporary-result.example/clean.png?Expires=123",
    );
    assert.equal(calls[4]?.init?.method, "GET");
    assert.deepEqual(calls[4]?.init?.headers, {});
    assert.equal(calls[4]?.init?.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("throws a terminal task failure containing the task_id and provider details", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    Response.json({
      request_id: "submit-request",
      output: { task_id: "task-failed", task_status: "PENDING" },
    }),
    Response.json({
      request_id: "poll-failed",
      output: {
        task_id: "task-failed",
        task_status: "FAILED",
        code: "InvalidParameter",
        message: "mask is invalid",
      },
    }),
  ];

  globalThis.fetch = async () => {
    const response = responses.shift();
    assert.ok(response);
    return response;
  };

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), config),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /task-failed/);
        assert.match(error.message, /FAILED/);
        assert.match(error.message, /InvalidParameter/);
        assert.match(error.message, /mask is invalid/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifies an in-flight poll deadline abort as timeout and preserves task_id", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/image-synthesis")) {
      return Response.json({
        request_id: "submit-request",
        output: { task_id: "task-poll-timeout", task_status: "PENDING" },
      });
    }

    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      const rejectWithSignalReason = () => reject(signal.reason);
      if (signal.aborted) {
        rejectWithSignalReason();
        return;
      }
      signal.addEventListener("abort", rejectWithSignalReason, { once: true });
    });
  };

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), {
        ...config,
        requestTimeoutMs: 25,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /task-poll-timeout/);
        assert.match(error.message, /timed out/i);
        assert.ok(error.cause instanceof DOMException);
        assert.equal(error.cause.name, "TimeoutError");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifies a poll response body deadline abort as timeout and preserves task_id", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/image-synthesis")) {
      return Response.json({
        request_id: "submit-request",
        output: { task_id: "task-body-timeout", task_status: "PENDING" },
      });
    }

    const signal = init?.signal;
    assert.ok(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const failBodyWithSignalReason = () => controller.error(signal.reason);
        if (signal.aborted) {
          failBodyWithSignalReason();
          return;
        }
        signal.addEventListener("abort", failBodyWithSignalReason, {
          once: true,
        });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), {
        ...config,
        requestTimeoutMs: 25,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /task-body-timeout/);
        assert.match(error.message, /timed out/i);
        assert.ok(error.cause instanceof DOMException);
        assert.equal(error.cause.name, "TimeoutError");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not classify an ordinary poll abort as a configured timeout", async () => {
  const originalFetch = globalThis.fetch;
  const ordinaryAbort = new DOMException("upstream aborted", "AbortError");

  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/image-synthesis")) {
      return Response.json({
        request_id: "submit-request",
        output: { task_id: "task-ordinary-abort", task_status: "PENDING" },
      });
    }
    throw ordinaryAbort;
  };

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), config),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /task-ordinary-abort/);
        assert.match(error.message, /poll failed/i);
        assert.doesNotMatch(error.message, /timed out/i);
        assert.equal(error.cause, ordinaryAbort);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifies an in-flight result download deadline abort as timeout and preserves task_id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createSuccessfulTaskFetch(
    "task-download-timeout",
    async (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      return new Promise<Response>((_resolve, reject) => {
        const rejectWithSignalReason = () => reject(signal.reason);
        if (signal.aborted) {
          rejectWithSignalReason();
          return;
        }
        signal.addEventListener("abort", rejectWithSignalReason, {
          once: true,
        });
      });
    },
  );

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), {
        ...config,
        requestTimeoutMs: 25,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /task-download-timeout/);
        assert.match(error.message, /timed out/i);
        assert.ok(error.cause instanceof DOMException);
        assert.equal(error.cause.name, "TimeoutError");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifies a result download body deadline abort as timeout and preserves task_id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createSuccessfulTaskFetch(
    "task-download-body-timeout",
    async (_input, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const failBodyWithSignalReason = () =>
            controller.error(signal.reason);
          if (signal.aborted) {
            failBodyWithSignalReason();
            return;
          }
          signal.addEventListener("abort", failBodyWithSignalReason, {
            once: true,
          });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    },
  );

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), {
        ...config,
        requestTimeoutMs: 25,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /task-download-body-timeout/);
        assert.match(error.message, /timed out/i);
        assert.ok(error.cause instanceof DOMException);
        assert.equal(error.cause.name, "TimeoutError");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not classify an ordinary result download abort as timeout", async () => {
  const originalFetch = globalThis.fetch;
  const ordinaryAbort = new DOMException("upstream aborted", "AbortError");
  globalThis.fetch = createSuccessfulTaskFetch(
    "task-download-abort",
    async () => {
      throw ordinaryAbort;
    },
  );

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), config),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /task-download-abort/);
        assert.match(error.message, /result download failed/i);
        assert.doesNotMatch(error.message, /timed out/i);
        assert.equal(error.cause, ordinaryAbort);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not classify an ordinary result body abort as timeout", async () => {
  const originalFetch = globalThis.fetch;
  const ordinaryAbort = new DOMException("body aborted", "AbortError");
  globalThis.fetch = createSuccessfulTaskFetch(
    "task-download-body-abort",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(ordinaryAbort);
          },
        }),
        { status: 200, headers: { "Content-Type": "image/png" } },
      ),
  );

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), config),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /task-download-body-abort/);
        assert.match(error.message, /result download could not be read/i);
        assert.doesNotMatch(error.message, /timed out/i);
        assert.equal(error.cause, ordinaryAbort);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an unvalidated Wanx base before sending credentials", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("must not be called");
  };

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), {
        ...config,
        dashscopeApiBase: "https://attacker.example/api/v1",
      }),
      /safe Alibaba China Wanx base URL/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
