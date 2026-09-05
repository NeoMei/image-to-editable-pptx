import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import {
  createAlibabaExecutors,
  createGeminiExecutors,
  createHostExecutors,
  createOpenAiExecutors,
  prepareCompletion,
} from "../src/providers/provider-adapters.js";
import { ProviderFailure, SerialOperationRouter } from "../src/providers/routing.js";
import { sourceLockedOcclusionFixture } from "./fixtures/occlusion/source-locked.js";

const canvas = { width: 64, height: 32 } as const;

const alibabaConfig = {
  apiKey: "alibaba-key",
  workspaceId: "workspace-123",
  dashscopeApiBase: "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1",
  dashscopeCompatibleBase: "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ocrModel: "qwen3.5-ocr",
  visionModel: "qwen3-vl-plus",
  editModel: "wanx2.1-imageedit",
  requestTimeoutMs: 1000,
  pollIntervalMs: 1,
} as const;

async function png(width: number = canvas.width, height: number = canvas.height): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: "#336699" },
  }).png().toBuffer();
}

async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
  const decoded = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * decoded.info.width + x) * decoded.info.channels;
  return [...decoded.data.subarray(offset, offset + 4)];
}

async function fixtureMask(mask: Uint8Array): Promise<Buffer> {
  return sharp(mask, { raw: { width: 32, height: 24, channels: 1 } }).png().toBuffer();
}

const sceneText = JSON.stringify({
  nodes: [{
    id: "background", role: "background", bbox: [0, 0, 1000, 1000],
    confidence: 1, zIndex: 0, label: "canvas", extractionHints: [],
  }],
  relations: [],
});

test("OpenAI OCR uses the fixed Responses endpoint and validates pixel geometry", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init! });
    return new Response(JSON.stringify({
      status: "completed",
      model: "gpt-4.1-2026-08-01",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
        lines: [{
          text: "hello",
          bbox: { x: 2, y: 3, width: 10, height: 8 },
          quad: [{ x: 2, y: 3 }, { x: 12, y: 3 }, { x: 12, y: 11 }, { x: 2, y: 11 }],
        }],
      }) }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const executors = createOpenAiExecutors({
    apiKey: "openai-test-key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
    requestTimeoutMs: 1000, maxAttempts: 2, fetch: fetcher,
  });
  const result = await executors.ocr!({ image: await png(), canvas });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.validated, true);
    assert.equal(result.model, "gpt-4.1-2026-08-01");
    assert.equal(result.value.lines[0]?.text, "hello");
  }
  assert.equal(requests[0]?.url, "https://api.openai.com/v1/responses");
  assert.equal((requests[0]?.init.headers as Record<string, string>).Authorization, "Bearer openai-test-key");
  assert.equal(requests[0]?.init.redirect, "error");
});

test("OpenAI explicit refusal is fatal and is never retried", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      model: "gpt-4.1",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "blocked" }] }],
    }), { status: 200 });
  };
  const result = await createOpenAiExecutors({
    apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
    requestTimeoutMs: 1000, maxAttempts: 2, fetch: fetcher,
  }).scene!({ image: await png(), canvas, prompt: "scene" });

  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "policy_refused");
});

test("OpenAI invalid OCR coordinates are fatal invalid output", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    status: "completed",
    model: "gpt-4.1",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      lines: [{
        text: "escape", bbox: { x: 60, y: 1, width: 10, height: 5 },
        quad: [{ x: 60, y: 1 }, { x: 70, y: 1 }, { x: 70, y: 6 }, { x: 60, y: 6 }],
      }],
    }) }] }],
  }), { status: 200 });
  const result = await createOpenAiExecutors({
    apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
    requestTimeoutMs: 1000, maxAttempts: 1, fetch: fetcher,
  }).ocr!({ image: await png(), canvas });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "invalid_output");
});

for (const operation of ["ocr", "scene"] as const) {
  for (const [name, envelope, expected] of [
    ["failed", { status: "failed", error: { code: "server_error" } }, "invalid_output"],
    ["filtered incomplete", { status: "incomplete", incomplete_details: { reason: "content_filter" } }, "policy_refused"],
    ["filtered failure", { status: "failed", error: { code: "content_filter" } }, "policy_refused"],
    ["token-limited incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "invalid_output"],
    ["in progress", { status: "in_progress" }, "invalid_output"],
    ["cancelled", { status: "cancelled" }, "invalid_output"],
    ["missing status", {}, "invalid_output"],
    ["completed with error", { status: "completed", error: { code: "server_error" } }, "invalid_output"],
    ["completed with incomplete details", { status: "completed", incomplete_details: { reason: "max_output_tokens" } }, "invalid_output"],
  ] as const) {
    test(`OpenAI ${operation} rejects ${name} despite valid payload and stops routing`, async () => {
      let calls = 0;
      const executors = createOpenAiExecutors({
        apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
        requestTimeoutMs: 1000, maxAttempts: 2,
        fetch: async () => {
          calls++;
          return Response.json({
            ...envelope, model: "gpt-4.1",
            output: [{ type: "message", status: "completed", content: [{
              type: "output_text", text: operation === "ocr" ? '{"lines":[]}' : sceneText,
            }] }],
          });
        },
      });
      const request = { image: await png(), canvas, prompt: "scene" };
      const router = new SerialOperationRouter();
      const result = await router.route<unknown>(operation, {
        "api-openai": () => executors[operation]!(request),
        "host-gemini": async () => { assert.fail("fatal envelope must not advance to Gemini"); },
      });
      assert.equal(result.outcome, "fatal");
      assert.equal(result.attempts.at(-1)?.status, expected);
      assert.equal(router.report.stopped, true);
      assert.equal(calls, 1);
    });
  }

  test(`OpenAI ${operation} accepts a completed envelope with null error fields`, async () => {
    const executors = createOpenAiExecutors({
      apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
      requestTimeoutMs: 1000, maxAttempts: 1,
      fetch: async () => Response.json({
        status: "completed", error: null, incomplete_details: null, model: "gpt-4.1",
        output: [{ type: "message", status: "completed", content: [{
          type: "output_text", text: operation === "ocr" ? '{"lines":[]}' : sceneText,
        }] }],
      }),
    });
    const result = await executors[operation]!({ image: await png(), canvas, prompt: "scene" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.validated, true);
  });

  for (const [name, body] of [
    ["truncated envelope", '{"status":"completed","output":'],
    ["malformed output JSON", JSON.stringify({ status: "completed", output: [{
      type: "message", content: [{ type: "output_text", text: '{"lines":' }],
    }] })],
  ] as const) {
    test(`OpenAI ${operation} keeps ${name} fatal`, async () => {
      const executors = createOpenAiExecutors({
        apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
        requestTimeoutMs: 1000, maxAttempts: 2,
        fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
      });
      const result = await executors[operation]!({ image: await png(), canvas, prompt: "scene" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failure.status, "invalid_output");
    });
  }
}

test("Gemini scene uses fixed generateContent endpoint and accepts inlineData output aliases", async () => {
  let requestUrl = "";
  let headers: HeadersInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    headers = init?.headers;
    return new Response(JSON.stringify({
      modelVersion: "gemini-2.5-flash-2026-08",
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: sceneText }] } }],
    }), { status: 200 });
  };
  const result = await createGeminiExecutors({
    apiKey: "gemini-test-key", analysisModel: "gemini-2.5-flash",
    imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
    maxAttempts: 1, fetch: fetcher,
  }).scene!({ image: await png(), canvas, prompt: "scene" });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.model, "gemini-2.5-flash-2026-08");
  assert.equal(requestUrl, "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent");
  assert.equal((headers as Record<string, string>)["x-goog-api-key"], "gemini-test-key");
});

test("Gemini OCR ignores thought text and parses the final answer", async () => {
  const finalText = JSON.stringify({
    lines: [{
      text: "actual",
      bbox: { x: 2, y: 3, width: 10, height: 8 },
      quad: [{ x: 2, y: 3 }, { x: 12, y: 3 }, { x: 12, y: 11 }, { x: 2, y: 11 }],
    }],
  });
  const result = await createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash",
    imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
    maxAttempts: 1,
    fetch: async () => Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [
        { thought: true, text: '{"lines":[]}' },
        { text: finalText },
      ] } }],
    }),
  }).ocr!({ image: await png(), canvas });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.lines[0]?.text, "actual");
});

test("Gemini scene joins split final text parts in order", async () => {
  const splitAt = Math.floor(sceneText.length / 2);
  const result = await createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash",
    imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
    maxAttempts: 1,
    fetch: async () => Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [
        { text: sceneText.slice(0, splitAt) },
        { text: sceneText.slice(splitAt) },
      ] } }],
    }),
  }).scene!({ image: await png(), canvas, prompt: "scene" });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.nodes[0]?.id, "background");
});

test("Gemini image completion excludes thought images and rejects incompatible geometry", async () => {
  const thought = await png(64, 32);
  const incompatible = await png(32, 64);
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    modelVersion: "gemini-3.1-flash-image",
    candidates: [{ finishReason: "STOP", content: { parts: [
      { thought: true, inlineData: { mimeType: "image/png", data: thought.toString("base64") } },
      { inline_data: { mime_type: "image/png", data: incompatible.toString("base64") } },
    ] } }],
  }), { status: 200 });
  const result = await createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash",
    imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
    maxAttempts: 1, fetch: fetcher,
  }).completion!({
    image: await png(), canvas, prompt: "complete", hiddenMask: await png(),
    protectedMask: await png(),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "invalid_output");
});

test("completion padding reads alpha support without treating transparent white as protected", async () => {
  const crop = { width: 2, height: 2 };
  const mask = await sharp(Buffer.from([
    255, 255, 255, 0, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 0,
  ]), { raw: { ...crop, channels: 4 } }).png().toBuffer();
  const prepared = await prepareCompletion({
    image: await png(2, 2), canvas: crop, prompt: "complete",
    hiddenMask: mask, protectedMask: mask,
  });
  const protectedPixels = await sharp(prepared.protectedMask).greyscale().raw().toBuffer();
  const hiddenPixels = await sharp(prepared.hiddenMask).extractChannel("alpha").raw().toBuffer();
  const first = prepared.crop.top * prepared.canvas.width + prepared.crop.left;
  const second = first + prepared.canvas.width;
  assert.deepEqual([
    protectedPixels[first], protectedPixels[first + 1],
    protectedPixels[second], protectedPixels[second + 1],
  ], [0, 255, 255, 0]);
  assert.deepEqual([
    hiddenPixels[first], hiddenPixels[first + 1],
    hiddenPixels[second], hiddenPixels[second + 1],
  ], [255, 0, 0, 255]);
  assert.equal(protectedPixels[0], 0);
  assert.equal(hiddenPixels[0], 255);
});

test("OpenAI completion pads to valid geometry, sends transparent hidden mask, and removes only local padding", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const source = fixture.pngs.cleared;
  const hiddenMask = await fixtureMask(fixture.masks.hidden);
  const protectedPixels = Uint8Array.from(
    fixture.masks.hidden,
    (value) => value === 0 ? 255 : 0,
  );
  const protectedMask = await fixtureMask(protectedPixels);
  let submittedSize = "";
  let transparentPixels = 0;
  let submittedImage: Buffer | undefined;
  let submittedMask: Buffer | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    const form = init?.body as FormData;
    submittedSize = String(form.get("size"));
    const [width, height] = submittedSize.split("x").map(Number) as [number, number];
    const imageFile = form.get("image") as Blob;
    const maskFile = form.get("mask") as Blob;
    submittedImage = Buffer.from(await imageFile.arrayBuffer());
    submittedMask = Buffer.from(await maskFile.arrayBuffer());
    const decodedMask = await sharp(Buffer.from(await maskFile.arrayBuffer())).ensureAlpha().raw().toBuffer();
    for (let offset = 3; offset < decodedMask.length; offset += 4) {
      if (decodedMask[offset] === 0) transparentPixels += 1;
    }
    const generated = Buffer.from(submittedImage);
    return new Response(JSON.stringify({ model: "gpt-image-2-effective", data: [{ b64_json: generated.toString("base64") }] }), { status: 200 });
  };
  const result = await createOpenAiExecutors({
    apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
    requestTimeoutMs: 1000, maxAttempts: 1, fetch: fetcher,
  }).completion!({ image: source, canvas: fixture.geometry.canvas, prompt: "complete", hiddenMask, protectedMask });

  const [paddedWidth, paddedHeight] = submittedSize.split("x").map(Number) as [number, number];
  assert.equal(paddedWidth % 16, 0);
  assert.equal(paddedHeight % 16, 0);
  assert.ok(paddedWidth * paddedHeight >= 655_360);
  assert.ok(Math.max(paddedWidth / paddedHeight, paddedHeight / paddedWidth) <= 3);
  assert.equal(transparentPixels, 80);
  assert.ok(submittedImage);
  assert.ok(submittedMask);
  const left = (paddedWidth - 32) / 2;
  const top = (paddedHeight - 24) / 2;
  assert.deepEqual(await pixel(submittedImage, left + 14, top + 4), [0, 0, 0, 0]);
  assert.deepEqual(await pixel(submittedImage, left + 4, top + 4), [40, 100, 160, 255]);
  assert.deepEqual(await pixel(submittedMask, left + 14, top + 4), [255, 255, 255, 0]);
  assert.deepEqual(await pixel(submittedMask, left + 4, top + 4), [255, 255, 255, 255]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(await sharp(result.value.image).metadata().then(({ width, height }) => ({ width, height })), fixture.geometry.canvas);
    assert.deepEqual(await pixel(result.value.image, 14, 4), [0, 0, 0, 0]);
    assert.deepEqual(await pixel(result.value.image, 4, 4), [40, 100, 160, 255]);
    assert.equal(result.model, "gpt-image-2-effective");
  }
});

test("Gemini API completion carries the cleared crop through padding and crop reversal", async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const hiddenMask = await fixtureMask(fixture.masks.hidden);
  const protectedMask = await fixtureMask(
    Uint8Array.from(fixture.masks.hidden, (value) => value === 0 ? 255 : 0),
  );
  let submittedImage: Buffer | undefined;
  let submittedMask: Buffer | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const parts = body.contents[0].parts;
    submittedImage = Buffer.from(parts[1].inline_data.data, "base64");
    submittedMask = Buffer.from(parts[2].inline_data.data, "base64");
    return Response.json({
      modelVersion: "gemini-3.1-flash-image",
      candidates: [{ finishReason: "STOP", content: { parts: [{
        inlineData: { mimeType: "image/png", data: submittedImage.toString("base64") },
      }] } }],
    });
  };
  const result = await createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash",
    imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
    maxAttempts: 1, fetch: fetcher,
  }).completion!({
    image: fixture.pngs.cleared,
    canvas: fixture.geometry.canvas,
    prompt: "complete rear object",
    hiddenMask,
    protectedMask,
  });
  assert.ok(submittedImage);
  assert.ok(submittedMask);
  assert.deepEqual(await pixel(submittedImage, 456 + 14, 340 + 4), [0, 0, 0, 0]);
  assert.deepEqual(await pixel(submittedImage, 456 + 4, 340 + 4), [40, 100, 160, 255]);
  assert.deepEqual(await pixel(submittedMask, 456 + 14, 340 + 4), [255, 255, 255, 0]);
  assert.deepEqual(await pixel(submittedMask, 456 + 4, 340 + 4), [255, 255, 255, 255]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(await pixel(result.value.image, 14, 4), [0, 0, 0, 0]);
    assert.deepEqual(await pixel(result.value.image, 4, 4), [40, 100, 160, 255]);
  }
});

test("Gemini completion rejects ambiguous multiple final images", async () => {
  const image = await png(1024, 512);
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [
      { inlineData: { mimeType: "image/png", data: image.toString("base64") } },
      { inlineData: { mimeType: "image/png", data: image.toString("base64") } },
    ] } }],
  }), { status: 200 });
  const result = await createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash", imageModel: "gemini-3.1-flash-image",
    requestTimeoutMs: 1000, maxAttempts: 1, fetch: fetcher,
  }).completion!({ image: await png(), canvas, prompt: "complete", hiddenMask: await png(), protectedMask: await png() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "invalid_output");
});

test("OpenAI completion rejects multiple results and stops routing", async () => {
  const generated = await png(1152, 576);
  let fallbackCalls = 0;
  const executors = createOpenAiExecutors({
    apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
    requestTimeoutMs: 1000, maxAttempts: 1,
    fetch: async () => Response.json({ data: [
      { b64_json: generated.toString("base64") },
      { b64_json: generated.toString("base64") },
    ] }),
  });
  const image = await png();
  const router = new SerialOperationRouter();
  const result = await router.route("completion", {
    "api-openai": () => executors.completion!({
      image, canvas, prompt: "complete", hiddenMask: image, protectedMask: image,
    }),
    "host-gemini": async () => {
      fallbackCalls += 1;
      assert.fail("ambiguous OpenAI results must stop routing");
    },
  });

  assert.equal(result.outcome, "fatal");
  assert.equal(result.attempts.at(-1)?.status, "invalid_output");
  assert.equal(router.report.stopped, true);
  assert.equal(fallbackCalls, 0);
});

test("Gemini completion rejects multiple candidates and stops routing", async () => {
  const generated = await png(1152, 576);
  const candidate = {
    finishReason: "STOP",
    content: { parts: [{
      inlineData: { mimeType: "image/png", data: generated.toString("base64") },
    }] },
  };
  let fallbackCalls = 0;
  const executors = createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash", imageModel: "gemini-3.1-flash-image",
    requestTimeoutMs: 1000, maxAttempts: 1,
    fetch: async () => Response.json({ candidates: [candidate, candidate] }),
  });
  const image = await png();
  const router = new SerialOperationRouter();
  const result = await router.route("completion", {
    "api-gemini": () => executors.completion!({
      image, canvas, prompt: "complete", hiddenMask: image, protectedMask: image,
    }),
    "api-alibaba": async () => {
      fallbackCalls += 1;
      assert.fail("ambiguous Gemini candidates must stop routing");
    },
  });

  assert.equal(result.outcome, "fatal");
  assert.equal(result.attempts.at(-1)?.status, "invalid_output");
  assert.equal(router.report.stopped, true);
  assert.equal(fallbackCalls, 0);
});

test("Gemini documented content-filter finish reasons are fatal across OCR, scene, and completion", async () => {
  const cases = [
    { operation: "ocr", finishReason: "SPII" },
    { operation: "scene", finishReason: "RECITATION" },
    { operation: "completion", finishReason: "IMAGE_PROHIBITED_CONTENT" },
    { operation: "completion", finishReason: "IMAGE_RECITATION" },
    { operation: "scene", finishReason: "ESCALATION" },
  ] as const;

  for (const { operation, finishReason } of cases) {
    let calls = 0;
    const executors = createGeminiExecutors({
      apiKey: "key", analysisModel: "gemini-2.5-flash",
      imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
      maxAttempts: 2,
      fetch: async () => {
        calls += 1;
        return Response.json({ candidates: [{ finishReason }] });
      },
    });
    const image = await png();
    const result = operation === "ocr"
      ? await executors.ocr!({ image, canvas })
      : operation === "scene"
        ? await executors.scene!({ image, canvas, prompt: "scene" })
        : await executors.completion!({
            image, canvas, prompt: "complete",
            hiddenMask: image, protectedMask: image,
          });

    assert.equal(result.ok, false, `${finishReason} must fail`);
    if (!result.ok) {
      assert.equal(result.failure.status, "policy_refused", finishReason);
    }
    assert.equal(calls, 1, `${finishReason} must not retry`);
  }
});

test("Gemini prompt-level blocking is fatal and is never retried", async () => {
  let calls = 0;
  const result = await createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash",
    imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
    maxAttempts: 2,
    fetch: async () => {
      calls += 1;
      return Response.json({ promptFeedback: { blockReason: "SAFETY" } });
    },
  }).ocr!({ image: await png(), canvas });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "policy_refused");
  assert.equal(calls, 1);
});

test("Gemini non-policy finish reasons remain invalid output rather than refusals", async () => {
  const cases = [
    { operation: "ocr", finishReason: "LANGUAGE" },
    { operation: "scene", finishReason: "OTHER" },
    { operation: "completion", finishReason: "NO_IMAGE" },
    { operation: "completion", finishReason: "IMAGE_OTHER" },
  ] as const;

  for (const { operation, finishReason } of cases) {
    let calls = 0;
    let fallbackCalls = 0;
    const generated = await png(1152, 576);
    const executors = createGeminiExecutors({
      apiKey: "key", analysisModel: "gemini-2.5-flash",
      imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
      maxAttempts: 1,
      fetch: async () => {
        calls += 1;
        return Response.json({
          candidates: [{
            finishReason,
            content: { parts: operation === "completion"
              ? [{ inlineData: { mimeType: "image/png", data: generated.toString("base64") } }]
              : [{ text: operation === "ocr" ? '{"lines":[]}' : sceneText }],
            },
          }],
        });
      },
    });
    const image = await png();
    const router = new SerialOperationRouter();
    const result = await router.route<unknown>(operation, {
      "api-gemini": () => operation === "ocr"
        ? executors.ocr!({ image, canvas })
        : operation === "scene"
          ? executors.scene!({ image, canvas, prompt: "scene" })
          : executors.completion!({
              image, canvas, prompt: "complete",
              hiddenMask: image, protectedMask: image,
            }),
      "api-alibaba": async () => {
        fallbackCalls += 1;
        assert.fail("invalid Gemini finish state must stop routing");
      },
    });

    assert.equal(result.outcome, "fatal", `${finishReason} must be terminal`);
    assert.equal(result.attempts.at(-1)?.status, "invalid_output", finishReason);
    assert.equal(router.report.stopped, true);
    assert.equal(calls, 1);
    assert.equal(fallbackCalls, 0);
  }
});

test("host output is semantically validated before becoming router success", async () => {
  const image = await png();
  const executors = createHostExecutors({
    capabilities: {
      openai: { ocr: true, scene: true, completion: true },
      gemini: { ocr: false, scene: false, completion: false },
    },
    invoke: async (_provider, request) => request.operation === "scene"
      ? { ok: true, model: "host-scene", output: { kind: "text", text: sceneText } }
      : { ok: true, model: "host-model", output: { kind: "text", text: "not-an-image" } },
  });

  const scene = await executors.openai.scene!({ image, canvas, prompt: "scene" });
  assert.equal(scene.ok, true);
  const completion = await executors.openai.completion!({
    image, canvas, prompt: "complete", hiddenMask: image, protectedMask: image,
  });
  assert.equal(completion.ok, false);
  if (!completion.ok) assert.equal(completion.failure.status, "invalid_output");
});

test("host completion rejects unsupported and multi-frame image artifacts", async (t) => {
  const framePixels = Buffer.alloc(canvas.width * canvas.height * 2 * 4, 255);
  for (let offset = 0; offset < canvas.width * canvas.height * 4; offset += 4) {
    framePixels[offset] = 255;
    framePixels[offset + 1] = 0;
    framePixels[offset + 2] = 0;
  }
  for (let offset = canvas.width * canvas.height * 4; offset < framePixels.length; offset += 4) {
    framePixels[offset] = 0;
    framePixels[offset + 1] = 0;
    framePixels[offset + 2] = 255;
  }
  const frames = sharp(framePixels, {
    raw: { width: canvas.width, height: canvas.height * 2, channels: 4, pageHeight: canvas.height },
  });
  const cases = [
    {
      name: "SVG",
      artifact: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"/>`),
    },
    { name: "animated GIF", artifact: await frames.clone().gif({ loop: 0, delay: [100, 100] }).toBuffer() },
    { name: "multipage TIFF", artifact: await frames.clone().tiff().toBuffer() },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const executors = createHostExecutors({
        capabilities: {
          openai: { ocr: false, scene: false, completion: true },
          gemini: { ocr: false, scene: false, completion: false },
        },
        invoke: async () => ({
          ok: true, model: "host-image", output: { kind: "image", image: entry.artifact },
        }),
      });
      const image = await png();
      const result = await executors.openai.completion!({
        image, canvas, prompt: "complete", hiddenMask: image, protectedMask: image,
      });

      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failure.status, "invalid_output");
    });
  }
});

test("host completion accepts single-frame PNG and JPEG artifacts", async () => {
  for (const artifact of [
    await png(),
    await sharp({
      create: { ...canvas, channels: 3, background: "#336699" },
    }).jpeg().toBuffer(),
  ]) {
    const executors = createHostExecutors({
      capabilities: {
        openai: { ocr: false, scene: false, completion: true },
        gemini: { ocr: false, scene: false, completion: false },
      },
      invoke: async () => ({
        ok: true, model: "host-image", output: { kind: "image", image: artifact },
      }),
    });
    const image = await png();
    const result = await executors.openai.completion!({
      image, canvas, prompt: "complete", hiddenMask: image, protectedMask: image,
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal((await sharp(result.value.image).metadata()).format, "png");
  }
});

test("transient transport is bounded and authentication advances without retry", async () => {
  let transientCalls = 0;
  const recordedAttempts: number[] = [];
  const transient = createOpenAiExecutors({
    apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
    requestTimeoutMs: 1000, maxAttempts: 2,
    fetch: async () => { transientCalls += 1; throw new TypeError("network secret"); },
    onTransportAttempt: (attempt) => recordedAttempts.push(attempt),
  });
  const transientResult = await transient.ocr!({ image: await png(), canvas });
  assert.equal(transientCalls, 2);
  assert.deepEqual(recordedAttempts, [1, 2]);
  assert.equal(transientResult.ok, false);
  if (!transientResult.ok) assert.equal(transientResult.failure.status, "retryable_exhausted");

  let authCalls = 0;
  const auth = createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash",
    imageModel: "gemini-3.1-flash-image", requestTimeoutMs: 1000,
    maxAttempts: 2,
    fetch: async () => { authCalls += 1; return new Response("denied", { status: 401 }); },
  });
  const authResult = await auth.ocr!({ image: await png(), canvas });
  assert.equal(authCalls, 1);
  assert.equal(authResult.ok, false);
  if (!authResult.ok) assert.equal(authResult.failure.status, "auth_unavailable");
});

test("provider failures remain closed safe values", () => {
  assert.throws(() => new ProviderFailure("local_failure", "raw secret" as never));
});

test("429 retries are bounded and each HTTP attempt is observable", async () => {
  const attempts: number[] = [];
  let calls = 0;
  const result = await createOpenAiExecutors({
    apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
    requestTimeoutMs: 1000, maxAttempts: 2,
    onTransportAttempt: (attempt) => attempts.push(attempt),
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({
        status: "completed",
        model: "gpt-4.1",
        output: [{ type: "message", content: [{ type: "output_text", text: "{\"lines\":[]}" }] }],
      }), { status: 200 });
    },
  }).ocr!({ image: await png(), canvas });
  assert.equal(result.ok, true);
  assert.deepEqual(attempts, [1, 2]);
});

test("Alibaba observer I/O failure is local failure and cannot fall through", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ output: { choices: [] } });
  try {
    const executors = createAlibabaExecutors(alibabaConfig, {
      ocr: {
        async recordRawResponse() { throw new Error("filesystem unavailable"); },
        async recordRawHttpResponse() { throw new Error("filesystem unavailable"); },
        async recordParseError() { throw new Error("filesystem unavailable"); },
      },
    });
    const result = await executors.ocr!({ image: await png(), canvas });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.status, "local_failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Alibaba scene classifies OpenAI-compatible SDK HTTP failures by structured status", async () => {
  const cases = [
    { status: 401, code: "http_401", expected: "auth_unavailable" },
    { status: 403, code: "http_403", expected: "auth_unavailable" },
    { status: 404, code: "model_not_found", expected: "unavailable" },
    { status: 400, code: "model_not_found", expected: "unavailable" },
    { status: 408, code: "http_408", expected: "retryable_exhausted" },
    { status: 409, code: "http_409", expected: "retryable_exhausted" },
    { status: 429, code: "http_429", expected: "retryable_exhausted" },
    { status: 500, code: "http_500", expected: "retryable_exhausted" },
    { status: 503, code: "http_503", expected: "retryable_exhausted" },
  ] as const;
  const originalFetch = globalThis.fetch;
  try {
    for (const entry of cases) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return Response.json({
          error: {
            message: `status fixture ${entry.status}`,
            type: "invalid_request_error",
            code: entry.code,
          },
        }, { status: entry.status });
      };
      const result = await createAlibabaExecutors(alibabaConfig).scene!({
        image: await png(), canvas, prompt: "scene",
      });

      assert.equal(result.ok, false, `HTTP ${entry.status} must fail`);
      if (!result.ok) assert.equal(result.failure.status, entry.expected, `HTTP ${entry.status}`);
      assert.equal(calls, 1, `HTTP ${entry.status} uses the configured zero-retry SDK bound`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Alibaba scene classifies SDK transport failures as retryable exhausted", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError("fetch failed fixture");
  };
  try {
    const result = await createAlibabaExecutors(alibabaConfig).scene!({
      image: await png(), canvas, prompt: "scene",
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.status, "retryable_exhausted");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generated image MIME must match the bytes that were decoded", async () => {
  const jpeg = await sharp({
    create: { width: 1152, height: 576, channels: 3, background: "red" },
  }).jpeg().toBuffer();
  const result = await createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash", imageModel: "gemini-3.1-flash-image",
    requestTimeoutMs: 1000, maxAttempts: 1,
    fetch: async () => Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [{
        inlineData: { mimeType: "image/png", data: jpeg.toString("base64") },
      }] } }],
    }),
  }).completion!({
    image: await png(), canvas, prompt: "complete",
    hiddenMask: await png(), protectedMask: await png(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "invalid_output");
});

test("Gemini completion records the selected candidate finish reason", async () => {
  const generated = await png(1152, 576);
  const result = await createGeminiExecutors({
    apiKey: "key", analysisModel: "gemini-2.5-flash", imageModel: "gemini-3.1-flash-image",
    requestTimeoutMs: 1000, maxAttempts: 1,
    fetch: async () => Response.json({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{
        inlineData: { mimeType: "image/png", data: generated.toString("base64") },
      }] } }],
    }),
  }).completion!({
    image: await png(), canvas, prompt: "complete",
    hiddenMask: await png(), protectedMask: await png(),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.sanitizedMetadata, { finishReason: "MAX_TOKENS" });
  }
});
