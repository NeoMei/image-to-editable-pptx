import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { AppConfig } from "../src/config.js";
import {
  analyzeElements,
  parseQwenVisionContent,
} from "../src/providers/qwen-vision.js";

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

type VisionFixture = {
  choices: Array<{ message: { content: string } }>;
};

async function readFixture(): Promise<VisionFixture> {
  return JSON.parse(
    await readFile(
      resolve("tests/fixtures/qwen-vision-slide-07.json"),
      "utf8",
    ),
  ) as VisionFixture;
}

test("strips one outer Markdown fence and validates vision elements", async () => {
  const fixture = await readFixture();
  const result = parseQwenVisionContent(fixture.choices[0]!.message.content);

  assert.deepEqual(result.elements[0], {
    type: "panel",
    bbox: { x: 80, y: 160, width: 240, height: 320 },
    label: "content panel",
    zIndex: 2,
    editableAs: "native-shape",
    confidence: 0.95,
    fillColor: "F4EBDD",
    strokeColor: "23394D",
    cornerRadius: 16,
  });
  assert.equal(result.elements[1]?.type, "icon");
});

test("rejects nested Markdown fences after stripping only the outer fence", () => {
  assert.throws(
    () =>
      parseQwenVisionContent(
        '```json\n```json\n{"elements":[]}\n```\n```',
      ),
    /valid JSON/,
  );
});

test("rejects invalid element enums and out-of-canvas bboxes", () => {
  assert.throws(
    () =>
      parseQwenVisionContent(
        '{"elements":[{"type":"chart","bbox":[0,0,20,20],"label":"bad","zIndex":1,"editableAs":"bitmap","confidence":0.9}]}',
      ),
    /vision response/i,
  );
  assert.throws(
    () =>
      parseQwenVisionContent(
        '{"elements":[{"type":"photo","bbox":[1200,700,1300,740],"label":"bad bbox","zIndex":1,"editableAs":"bitmap","confidence":0.9}]}',
      ),
    /vision response/i,
  );
});

test("uses the compatible client with the requested model and constrained prompt", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = await readFixture();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      id: "offline-chat-completion",
      object: "chat.completion",
      created: 0,
      model: config.visionModel,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: fixture.choices[0]!.message.content,
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };

  try {
    const result = await analyzeElements(Buffer.from([0x89, 0x50]), config);

    assert.equal(result.elements.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      model: string;
      messages: Array<{ content: unknown }>;
    };
    assert.equal(body.model, config.visionModel);
    const serializedPrompt = JSON.stringify(body.messages[0]?.content);
    assert.match(serializedPrompt, /JSON only/i);
    assert.match(
      serializedPrompt,
      /text \| panel \| shape \| icon \| illustration \| photo \| background/,
    );
    assert.match(serializedPrompt, /1280 x 720/);
    assert.match(serializedPrompt, /do not duplicate OCR text as graphical assets/i);
    assert.match(serializedPrompt, /data:image\/png;base64,iVA=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an unvalidated compatible base before constructing a credentialed client", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("must not be called");
  };

  try {
    await assert.rejects(
      analyzeElements(Buffer.from("image"), {
        ...config,
        dashscopeCompatibleBase:
          "https://workspace-123.cn-beijing.maas.aliyuncs.com.evil.example/compatible-mode/v1",
      }),
      /safe Alibaba China compatible base URL/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
