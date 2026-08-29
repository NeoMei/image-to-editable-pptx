import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import {
  createWanxOcclusionCompletionProvider,
  inpaintBackground,
} from "../src/providers/wanx-edit.js";

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

test("does not persist signed result URL query parameters in test source", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8");
  const signedResultUrlPattern =
    /https:\/\/[^\s"'`]+[?&](?:Expires|OSSAccessKeyId|Signature)=/i;

  assert.equal(
    signedResultUrlPattern.test(source),
    false,
    "Wanx test source must use unsigned inert result URLs",
  );
});

function createSuccessfulTaskFetch(
  taskId: string,
  download: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  const resultUrl = `https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/${taskId}.png`;
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

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const onAbort = () => {
      clearTimeout(watchdog);
      reject(signal.reason);
    };
    const watchdog = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Expected the deadline signal to abort"));
    }, 1_000);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function streamThatErrorsWhenAborted(
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        clearTimeout(watchdog);
        controller.error(signal.reason);
      };
      const watchdog = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        controller.error(new Error("Expected the deadline signal to abort"));
      }, 1_000);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    },
  });
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
            url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/clean.png",
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
      "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/clean.png",
    );
    assert.equal(calls[4]?.init?.method, "GET");
    assert.deepEqual(calls[4]?.init?.headers, {});
    assert.equal(calls[4]?.init?.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adapts Wanx to the provider-neutral completion contract with sanitized metadata", async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const downloaded = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa]);
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/image-synthesis")) {
      return Response.json({
        request_id: "signed-or-sensitive-submit-id",
        output: { task_id: "task-completion", task_status: "PENDING" },
      });
    }
    if (String(input).endsWith("/tasks/task-completion")) {
      return Response.json({
        request_id: "signed-or-sensitive-poll-id",
        output: {
          task_id: "task-completion",
          task_status: "SUCCEEDED",
          results: [
            {
              url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/completed.png",
            },
          ],
        },
        usage: { image_count: 1 },
      });
    }
    return new Response(downloaded, { status: 200 });
  };

  try {
    const provider = createWanxOcclusionCompletionProvider(config);
    const result = await provider.complete({
      crop: Buffer.from("candidate-crop"),
      hiddenMask: Buffer.from("hidden-mask"),
      protectedVisibleMask: Buffer.from("visible-mask"),
      semanticContext: ["continue the accepted rear contour"],
    });
    assert.deepEqual(result, {
      image: downloaded,
      modelId: "wanx2.1-imageedit",
      taskId: "task-completion",
      sanitizedMetadata: {
        taskStatus: "SUCCEEDED",
      },
    });
    assert.equal(calls[0]?.init?.redirect, "error");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      input: {
        base_image_url: string;
        mask_image_url: string;
        prompt: string;
      };
    };
    assert.equal(
      body.input.base_image_url,
      `data:image/png;base64,${Buffer.from("candidate-crop").toString("base64")}`,
    );
    assert.equal(
      body.input.mask_image_url,
      `data:image/png;base64,${Buffer.from("hidden-mask").toString("base64")}`,
    );
    assert.match(body.input.prompt, /accepted rear contour/i);
    assert.doesNotMatch(
      JSON.stringify(result.sanitizedMetadata),
      /request|url|signed/i,
    );
    assert.equal(calls[1]?.init?.redirect, "error");
    assert.equal(calls[2]?.init?.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts the authenticated Wanx ACDR result bucket observed from Model Studio", async () => {
  const originalFetch = globalThis.fetch;
  const resultUrl =
    "https://dashscope-5859.oss-cn-wulanchabu-acdr-1.aliyuncs.com/clean.png";
  const downloaded = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let fetchCount = 0;

  globalThis.fetch = async (input) => {
    fetchCount += 1;
    const url = String(input);
    if (url.endsWith("/image-synthesis")) {
      return Response.json({ output: { task_id: "task-acdr-result" } });
    }
    if (url.endsWith("/tasks/task-acdr-result")) {
      return Response.json({
        output: {
          task_id: "task-acdr-result",
          task_status: "SUCCEEDED",
          results: [{ url: resultUrl }],
        },
      });
    }
    assert.equal(url, resultUrl);
    return new Response(downloaded, { status: 200 });
  };

  try {
    const result = await inpaintBackground(
      Buffer.from("source"),
      Buffer.from("mask"),
      config,
    );
    assert.deepEqual(result.image, downloaded);
    assert.equal(fetchCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects provider-controlled result URLs outside the documented DashScope OSS family", async () => {
  const originalFetch = globalThis.fetch;
  const invalidUrls = [
    "not a URL",
    "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/clean.png",
    "https://user@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/clean.png",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8443/clean.png",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/clean.png#fragment",
    "https://127.0.0.1/clean.png",
    "https://[::1]/clean.png",
    "https://localhost/clean.png",
    "https://unrelated.example/clean.png",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.example/clean.png",
  ];

  try {
    for (const [index, resultUrl] of invalidUrls.entries()) {
      let fetchCount = 0;
      globalThis.fetch = async (input) => {
        fetchCount += 1;
        const url = String(input);
        if (url.endsWith("/image-synthesis")) {
          return Response.json({
            output: { task_id: `unsafe-${index}` },
          });
        }
        if (url.endsWith(`/tasks/unsafe-${index}`)) {
          return Response.json({
            output: {
              task_id: `unsafe-${index}`,
              task_status: "SUCCEEDED",
              results: [{ url: resultUrl }],
            },
          });
        }
        return new Response(Buffer.from("must-not-download"));
      };

      await assert.rejects(
        inpaintBackground(Buffer.from("source"), Buffer.from("mask"), config),
        /safe DashScope OSS result URL/i,
        resultUrl,
      );
      assert.equal(fetchCount, 2, `must reject before download: ${resultUrl}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a DashScope OSS result redirect without following it", async () => {
  const originalFetch = globalThis.fetch;
  let downloadInit: RequestInit | undefined;
  globalThis.fetch = createSuccessfulTaskFetch(
    "task-result-redirect",
    async (_input, init) => {
      downloadInit = init;
      return Response.redirect("https://unrelated.example/redirected.png", 302);
    },
  );

  try {
    await assert.rejects(
      inpaintBackground(Buffer.from("source"), Buffer.from("mask"), config),
      /result download failed with status 302/i,
    );
    assert.equal(downloadInit?.redirect, "error");
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
    return rejectWhenAborted(signal);
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
    const body = streamThatErrorsWhenAborted(signal);
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
      return rejectWhenAborted(signal);
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
      const body = streamThatErrorsWhenAborted(signal);
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
