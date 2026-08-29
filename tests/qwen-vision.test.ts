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

test("v1 compatibility parser strips one outer fence and validates elements", async () => {
  const fixture = await readFixture();
  const result = parseQwenVisionContent(fixture.choices[0]!.message.content);

  assert.deepEqual(
    result.elements.find((element) => element.label === "perception tools panel"),
    {
      type: "panel",
      bbox: { x: 60, y: 240, width: 273, height: 345 },
      label: "perception tools panel",
      zIndex: 1,
      editableAs: "native-shape",
      confidence: 0.99,
      fillColor: "F7F3E9",
      strokeColor: "456A84",
      cornerRadius: 20,
    },
  );
  assert.ok(result.elements.some((element) => element.type === "icon"));
});

test("v1 compatibility parser retains the historical fixed canvas", () => {
  const result = parseQwenVisionContent(
    '{"elements":[{"type":"panel","bbox":[47,334,259,810],"label":"panel","zIndex":1,"editableAs":"native-shape","confidence":0.99}]}',
  );

  assert.deepEqual(result.elements[0]?.bbox, {
    x: 60,
    y: 240,
    width: 272,
    height: 343,
  });
});

test("v1 compatibility parser replays the historical recording", async () => {
  const fixture = await readFixture();
  const result = parseQwenVisionContent(fixture.choices[0]!.message.content);
  const nativeShapeLabels = result.elements
    .filter(
      (element) =>
        (element.type === "panel" || element.type === "shape") &&
        element.editableAs === "native-shape" &&
        element.confidence >= 0.9,
    )
    .map((element) => element.label)
    .sort();
  const nativeShapeGeometry = Object.fromEntries(
    result.elements
      .filter(
        (element) =>
          (element.type === "panel" || element.type === "shape") &&
          element.editableAs === "native-shape" &&
          element.confidence >= 0.9,
      )
      .map((element) => [
        element.label,
        { bbox: element.bbox, cornerRadius: element.cornerRadius },
      ]),
  );
  const assetLabels = result.elements
    .filter(
      (element) =>
        (element.type === "icon" || element.type === "illustration") &&
        element.editableAs === "bitmap",
    )
    .map((element) => element.label)
    .sort();

  assert.deepEqual(
    nativeShapeLabels,
    [
      "MCP ecosystem panel",
      "bottom navy bar",
      "collaboration tools panel",
      "event-driven async Agent panel",
      "execution tools panel",
      "orange subtitle bar",
      "perception tools panel",
      "top section label",
    ].sort(),
  );
  assert.deepEqual(nativeShapeGeometry, {
    "top section label": {
      bbox: { x: 17, y: 14, width: 242, height: 59 },
      cornerRadius: 10,
    },
    "orange subtitle bar": {
      bbox: { x: 134, y: 162, width: 1024, height: 56 },
      cornerRadius: 8,
    },
    "perception tools panel": {
      bbox: { x: 60, y: 240, width: 273, height: 345 },
      cornerRadius: 20,
    },
    "execution tools panel": {
      bbox: { x: 352, y: 240, width: 261, height: 345 },
      cornerRadius: 20,
    },
    "collaboration tools panel": {
      bbox: { x: 628, y: 240, width: 273, height: 345 },
      cornerRadius: 20,
    },
    "MCP ecosystem panel": {
      bbox: { x: 923, y: 240, width: 299, height: 173 },
      cornerRadius: 20,
    },
    "event-driven async Agent panel": {
      bbox: { x: 923, y: 425, width: 299, height: 163 },
      cornerRadius: 20,
    },
    "bottom navy bar": {
      bbox: { x: 42, y: 607, width: 1198, height: 82 },
      cornerRadius: 10,
    },
  });
  assert.deepEqual(assetLabels, [
    "clock",
    "eye",
    "lightning",
    "plug",
    "speech bubbles",
    "wrench",
  ]);
  assert.equal(new Set(assetLabels).size, 6);
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

test("rejects invalid element enums and non-positive bboxes", () => {
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
        '{"elements":[{"type":"photo","bbox":[100,100,100,140],"label":"bad bbox","zIndex":1,"editableAs":"bitmap","confidence":0.9}]}',
      ),
    /vision response/i,
  );
});

test("v1 compatibility analyzer retains its recorded request contract", async () => {
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

    assert.equal(result.elements.length, 14);
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
    assert.match(serializedPrompt, /normalized integer coordinates from 0 to 999/i);
    assert.match(serializedPrompt, /do not duplicate OCR text as graphical assets/i);
    assert.match(serializedPrompt, /each independently movable object/i);
    assert.match(serializedPrompt, /complete antialiased edge/i);
    assert.match(serializedPrompt, /do not combine distinct objects/i);
    assert.match(serializedPrompt, /visibly connected/i);
    assert.match(serializedPrompt, /single compound/i);
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
