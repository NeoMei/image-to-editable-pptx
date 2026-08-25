import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import {
  parseQwenOcrResponse,
  recognizeText,
} from "../src/providers/qwen-ocr.js";

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
  pollIntervalMs: 2_000,
};

async function readFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve("tests/fixtures/qwen-ocr-slide-07.json"), "utf8"),
  );
}

test("normalizes a four-point OCR location to an axis-aligned bbox", async () => {
  const result = parseQwenOcrResponse(await readFixture());

  assert.deepEqual(result.lines[0], {
    text: "第 4 章 · 工具",
    bbox: { x: 38, y: 29, width: 201, height: 30 },
    quad: [
      { x: 38, y: 29 },
      { x: 239, y: 29 },
      { x: 239, y: 59 },
      { x: 38, y: 59 },
    ],
  });
});

test("contains representative slide 7 title and section text", async () => {
  const result = parseQwenOcrResponse(await readFixture());
  const text = new Set(result.lines.map((line) => line.text));

  assert.ok(result.lines.length >= 9);
  assert.ok(text.has("第 4 章 工具"));
  assert.ok(text.has("感知工具"));
  assert.ok(text.has("执行工具"));
  assert.ok(text.has("协作工具"));
  assert.ok(text.has("MCP 生态"));
  assert.ok(text.has("工具是 Agent 的手脚，定义能力边界"));
});

test("posts the exact OCR request to the validated Beijing endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(await readFixture());
  };

  try {
    const result = await recognizeText(Buffer.from([0x89, 0x50, 0x4e, 0x47]), config);

    assert.equal(result.lines.length, 10);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(calls[0]?.init?.headers, {
      Authorization: "Bearer offline-test-key",
      "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      model: "qwen3.5-ocr",
      input: {
        messages: [
          {
            role: "user",
            content: [
              {
                image: "data:image/png;base64,iVBORw==",
                enable_rotate: false,
              },
            ],
          },
        ],
      },
      parameters: { ocr_options: { task: "text_recognition" } },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an unvalidated OCR base before sending credentials", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("must not be called");
  };

  try {
    await assert.rejects(
      recognizeText(Buffer.from("image"), {
        ...config,
        dashscopeApiBase: "https://attacker.example/api/v1",
      }),
      /safe Alibaba China OCR base URL/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
