import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import {
  createGeminiExecutors,
  createHostExecutors,
  createOpenAiExecutors,
} from "../src/providers/provider-adapters.js";
import { ProviderFailure } from "../src/providers/routing.js";

const canvas = { width: 64, height: 32 } as const;

async function png(width: number = canvas.width, height: number = canvas.height): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: "#336699" },
  }).png().toBuffer();
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

test("OpenAI completion pads to valid geometry, sends transparent hidden mask, and removes only local padding", async () => {
  const source = await png();
  const hiddenMask = await sharp(Buffer.from([255, ...new Array(canvas.width * canvas.height - 1).fill(0)]), {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  }).png().toBuffer();
  const protectedMask = await sharp(Buffer.alloc(canvas.width * canvas.height, 255), {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  }).png().toBuffer();
  let submittedSize = "";
  let transparentPixels = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const form = init?.body as FormData;
    submittedSize = String(form.get("size"));
    const [width, height] = submittedSize.split("x").map(Number) as [number, number];
    const maskFile = form.get("mask") as Blob;
    const decodedMask = await sharp(Buffer.from(await maskFile.arrayBuffer())).ensureAlpha().raw().toBuffer();
    for (let offset = 3; offset < decodedMask.length; offset += 4) {
      if (decodedMask[offset] === 0) transparentPixels += 1;
    }
    const generated = await sharp({ create: { width, height, channels: 4, background: "#ff0000" } }).png().toBuffer();
    return new Response(JSON.stringify({ model: "gpt-image-2-effective", data: [{ b64_json: generated.toString("base64") }] }), { status: 200 });
  };
  const result = await createOpenAiExecutors({
    apiKey: "key", analysisModel: "gpt-4.1", imageModel: "gpt-image-2",
    requestTimeoutMs: 1000, maxAttempts: 1, fetch: fetcher,
  }).completion!({ image: source, canvas, prompt: "complete", hiddenMask, protectedMask });

  const [paddedWidth, paddedHeight] = submittedSize.split("x").map(Number) as [number, number];
  assert.equal(paddedWidth % 16, 0);
  assert.equal(paddedHeight % 16, 0);
  assert.ok(paddedWidth * paddedHeight >= 655_360);
  assert.ok(Math.max(paddedWidth / paddedHeight, paddedHeight / paddedWidth) <= 3);
  assert.equal(transparentPixels, 1);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(await sharp(result.value.image).metadata().then(({ width, height }) => ({ width, height })), canvas);
    assert.equal(result.model, "gpt-image-2-effective");
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
        model: "gpt-4.1",
        output: [{ type: "message", content: [{ type: "output_text", text: "{\"lines\":[]}" }] }],
      }), { status: 200 });
    },
  }).ocr!({ image: await png(), canvas });
  assert.equal(result.ok, true);
  assert.deepEqual(attempts, [1, 2]);
});
