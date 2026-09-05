import assert from "node:assert/strict";
import test from "node:test";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

import { discoverOpenCodexBridge as discoverBridge } from "../src/providers/opencodex-bridge.js";
import { createHostExecutors } from "../src/providers/provider-adapters.js";
import { runCli } from "../src/cli.js";
import { SerialOperationRouter } from "../src/providers/routing.js";
import { sourceLockedOcclusionFixture } from "./fixtures/occlusion/source-locked.js";

const discoverOpenCodexBridge: typeof discoverBridge = (env, options) => discoverBridge(env, {
  imageRouting: async () => ({}), ...options,
});

const endpoint = "http://127.0.0.1:10100/v1";
const models = [
  { id: "gpt-5.6-sol", owned_by: "openai", capabilities: { supports_vision: true } },
  { id: "google-antigravity/gemini-3.1-pro", owned_by: "google-antigravity", capabilities: { supports_vision: true } },
  { id: "google-antigravity/gemini-3.1-flash-image", owned_by: "google-antigravity", capabilities: { supports_vision: true } },
];
const response = (model: string, text: string) => ({
  status: "completed", model,
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
});
const input = async () => ({
  operation: "ocr" as const, prompt: "Return JSON only.", canvas: { width: 32, height: 32 },
  image: await sharp({ create: { width: 32, height: 32, channels: 3, background: "white" } }).png().toBuffer(),
});
const discover = () => Promise.resolve(JSON.stringify({ baseUrl: endpoint }));

test("local discovery allows a slow successful CLI to expose connected hosts", {
  skip: process.platform === "win32" ? "POSIX executable fixture" : false,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "image-ppt-slow-ocx-"));
  try {
    const executable = path.join(directory, "ocx");
    await copyFile(path.resolve("tests/fixtures/slow-opencodex.mjs"), executable);
    await chmod(executable, 0o700);
    const bridge = await discoverOpenCodexBridge({
      PATH: [directory, path.dirname(process.execPath)].join(path.delimiter),
    }, {
      fetch: async (url) => {
        assert.equal(String(url), `${endpoint}/models`);
        return Response.json({ data: models });
      },
    });
    assert.ok(bridge, "slow successful endpoint discovery must preserve host availability");
    assert.equal(bridge.capabilities.openai.ocr, true);
    assert.equal(bridge.capabilities.gemini.scene, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const completionInput = async () => {
  const fixture = await sourceLockedOcclusionFixture();
  const mask = (pixels: Uint8Array) => sharp(pixels, {
    raw: { ...fixture.geometry.canvas, channels: 1 },
  }).png().toBuffer();
  return {
    operation: "completion" as const,
    prompt: "Complete the rear object.",
    canvas: fixture.geometry.canvas,
    image: fixture.pngs.cleared,
    hiddenMask: await mask(fixture.masks.hidden),
    protectedMask: await mask(
      Uint8Array.from(fixture.masks.hidden, (value) => value === 0 ? 255 : 0),
    ),
  };
};

async function pixel(image: Buffer, x: number, y: number): Promise<number[]> {
  const decoded = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * decoded.info.width + x) * decoded.info.channels;
  return [...decoded.data.subarray(offset, offset + 4)];
}

test("discovers both signed-in host candidates without official API keys and uses streaming Codex Responses", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const bridge = await discoverOpenCodexBridge({}, {
    discover,
    fetch: async (url, init) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      if (String(url).endsWith("/models")) return Response.json({ data: models });
      const body = JSON.parse(String(init?.body));
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(init?.redirect, "error");
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.equal(body.model, "openai/gpt-5.6-sol");
      // The live Codex endpoint can omit output from response.completed.
      return new Response([
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: response("", '{"lines":[]}').output[0] })}\r\n\r\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", model: "gpt-5.6-sol", output: [] } })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.ok(bridge);
  assert.deepEqual(bridge.capabilities.openai, { ocr: true, scene: true, completion: true });
  assert.deepEqual(bridge.capabilities.gemini, { ocr: true, scene: true, completion: true });
  const result = await createHostExecutors(bridge).openai.ocr!(await input());
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { lines: [] });
  assert.equal(calls.length, 2);
});

test("Gemini analysis uses its explicit provider route, with no ChatGPT credential reuse", async () => {
  const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: models });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "google-antigravity/gemini-3.1-pro");
    assert.equal(body.stream, false);
    return Response.json(response("gemini-3.1-pro", '{"lines":[]}'));
  } });
  const result = await bridge!.invoke("gemini", await input());
  assert.ok(result.ok);
  assert.equal(result.model, "gemini-3.1-pro");
});

test("absent/disabled host stays optional, and discovery rejects non-loopback or credential-bearing endpoints", async () => {
  let discoveryCalls = 0;
  assert.equal(await discoverOpenCodexBridge({ IMAGE_PPT_OPENCODEX: "off" }, { discover: async () => { discoveryCalls++; return ""; } }), undefined);
  assert.equal(discoveryCalls, 0);
  assert.equal(await discoverOpenCodexBridge({}, { discover: async () => { throw new Error("not installed"); } }), undefined);
  for (const baseUrl of ["https://evil.example/v1", "http://127.0.0.1.evil.example/v1", "http://user:secret@127.0.0.1:10100/v1", `${endpoint}?key=secret`]) {
    assert.equal(await discoverOpenCodexBridge({}, { discover: async () => JSON.stringify({ baseUrl }), fetch: async () => { assert.fail("unsafe discovery made a request"); } }), undefined);
  }
});

for (const [name, payload, expected] of [
  ["refusal", { type: "response.refusal.done", refusal: "Blocked" }, "policy_refused"],
  ["incomplete", { type: "response.incomplete", response: { status: "incomplete" } }, "invalid_output"],
  ["interrupted", { type: "response.output_text.delta", delta: '{"lines":[]}' }, "invalid_output"],
] as const) {
  test(`Codex ${name} is never promoted to a successful/fallback result`, async () => {
    const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url) => String(url).endsWith("/models")
      ? Response.json({ data: models }) : new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
    const result = await bridge!.invoke("openai", await input());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.status, expected);
  });
}

for (const operation of ["ocr", "scene"] as const) {
  test(`explicit OpenCodex upstream reset advances ${operation} routing to the next available provider`, async () => {
    const scene = JSON.stringify({
      nodes: [{ id: "background", role: "background", bbox: [0, 0, 1000, 1000], confidence: 1, zIndex: 0, label: "canvas", extractionHints: [] }],
      relations: [],
    });
    const payloadText = operation === "ocr" ? '{"lines":[]}' : scene;
    const failure = { type: "upstream_error", code: "upstream_reset", message: "private-sentinel" };
    const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: models });
      const body = JSON.parse(String(init?.body));
      if (body.model === "google-antigravity/gemini-3.1-pro") return Response.json(response("gemini-3.1-pro", payloadText));
      assert.equal(body.model, "openai/gpt-5.6-sol");
      return new Response([
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: response("", payloadText).output[0] })}\n\n`,
        `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: failure, last_error: failure } })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    const executors = createHostExecutors(bridge!);
    const request = { ...await input(), operation };
    const router = new SerialOperationRouter();
    const result = await router.route<unknown>(operation, {
      "host-openai": () => executors.openai[operation]!(request),
      "host-gemini": () => executors.gemini[operation]!(request),
    });
    assert.equal(result.outcome, "success");
    assert.equal(result.selectedCandidate, "host-gemini");
    assert.deepEqual(result.attempts.map(({ candidate, status }) => ({ candidate, status })), [
      { candidate: "host-openai", status: "retryable_exhausted" },
      { candidate: "api-openai", status: "unavailable" },
      { candidate: "host-gemini", status: "success" },
    ]);
    if (result.outcome === "success" && operation === "ocr") assert.deepEqual(result.value, { lines: [] });
    assert.doesNotMatch(JSON.stringify(router.report), /private-sentinel/);
  });
}

for (const [name, data, expected] of [
  ["unknown upstream error", { type: "response.failed", response: { status: "failed", error: { type: "upstream_error", code: "unknown" } } }, "invalid_output"],
  ["translation buffer overflow", { type: "response.failed", response: { status: "failed", error: { type: "upstream_error", code: "translation_buffer_limit" } } }, "invalid_output"],
  ["reset without upstream type", { type: "response.failed", response: { status: "failed", error: { code: "upstream_reset" } } }, "invalid_output"],
  ["filtered reset", { type: "response.failed", response: { status: "failed", error: { type: "upstream_error", code: "upstream_reset" }, incomplete_details: { reason: "content_filter" } } }, "policy_refused"],
  ["completed item without terminal envelope", { type: "response.output_item.done", output_index: 0, item: response("", '{"lines":[]}').output[0] }, "invalid_output"],
  ["malformed JSON", '{"type":"response.failed"', "invalid_output"],
] as const) {
  test(`OpenCodex ${name} remains fatal without fallback`, async () => {
    const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url) => String(url).endsWith("/models")
      ? Response.json({ data: models })
      : new Response(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`, { headers: { "content-type": "text/event-stream" } }) });
    const request = await input();
    const router = new SerialOperationRouter();
    const result = await router.route("ocr", {
      "host-openai": () => createHostExecutors(bridge!).openai.ocr!(request),
      "api-openai": async () => { assert.fail("fatal stream must not advance"); },
    });
    assert.equal(result.outcome, "fatal");
    assert.equal(result.attempts[0]?.status, expected);
    assert.equal(result.attempts.length, 1);
  });
}

test("real host HTTP failures retain fallback classification and do not expose error bodies", async () => {
  for (const [status, expected] of [[401, "auth_unavailable"], [404, "unavailable"], [429, "retryable_exhausted"], [400, "invalid_input"]] as const) {
    const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url) => String(url).endsWith("/models")
      ? Response.json({ data: models }) : Response.json({ error: { message: "private-sentinel" } }, { status }) });
    const result = await bridge!.invoke("openai", await input());
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.failure.status, expected); assert.doesNotMatch(result.failure.message, /private-sentinel/); }
  }
});

test("CLI automatically attaches discovered host on live commands, never on offline build", async () => {
  let discoveries = 0;
  let calls = 0;
  const bridge = { capabilities: { openai: { ocr: true, scene: true, completion: false }, gemini: { ocr: false, scene: false, completion: false } }, invoke: async () => { throw new Error("not called"); } };
  const deps = {
    discoverHost: async () => { discoveries++; return bridge; },
    analyze: async (options: { hostBridge?: unknown }) => { assert.equal(options.hostBridge, bridge); calls++; },
    run: async (options: { hostBridge?: unknown }) => { assert.equal(options.hostBridge, bridge); calls++; },
    build: async () => { calls++; },
  };
  await runCli(["analyze", "image.png", "--out", "analysis"], {}, deps);
  await runCli(["run", "image.png", "--out", "result"], {}, deps);
  await runCli(["build", "--analysis", "analysis", "--out", "result"], {}, deps);
  assert.equal(discoveries, 2);
  assert.equal(calls, 3);
});

test("oversized OpenAI host image output is fatal, not a reason to try another provider", async () => {
  const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url) => String(url).endsWith("/models")
    ? Response.json({ data: models }) : new Response("{}", { headers: { "content-length": String(100 * 1024 * 1024) } }) });
  const result = await bridge!.invoke("openai", await completionInput());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "invalid_output");
});

test("OpenAI host completion sends a source/mask edit to loopback and unpads its result", async () => {
  let submittedImage: Buffer | undefined;
  const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: models });
    assert.equal(String(url), `${endpoint}/images/edits`);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "gpt-image-2");
    assert.equal(body.images.length, 3);
    assert.match(body.prompt, /alpha/);
    submittedImage = Buffer.from(body.images[0].image_url.split(",")[1], "base64");
    const submittedMask = Buffer.from(body.images[1].image_url.split(",")[1], "base64");
    assert.deepEqual(await pixel(submittedImage, 456 + 14, 340 + 4), [0, 0, 0, 0]);
    assert.deepEqual(await pixel(submittedImage, 456 + 4, 340 + 4), [40, 100, 160, 255]);
    assert.deepEqual(await pixel(submittedMask, 456 + 14, 340 + 4), [255, 255, 255, 0]);
    assert.deepEqual(await pixel(submittedMask, 456 + 4, 340 + 4), [255, 255, 255, 255]);
    return Response.json({ data: [{ b64_json: submittedImage.toString("base64") }] });
  } });
  const result = await bridge!.invoke("openai", await completionInput());
  assert.ok(result.ok);
  assert.equal(result.output.kind, "image");
  if (result.output.kind === "image") {
    assert.equal((await sharp(result.output.image).metadata()).width, 32);
    assert.deepEqual(await pixel(result.output.image, 14, 4), [0, 0, 0, 0]);
    assert.deepEqual(await pixel(result.output.image, 4, 4), [40, 100, 160, 255]);
  }
});

test("Gemini completion carries all three images and retrieves only the opaque loopback artifact", async () => {
  let padded: Buffer;
  let calls = 0;
  const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url, init) => {
    calls++;
    if (String(url).endsWith("/models")) return Response.json({ data: models });
    if (String(url).endsWith("/responses")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "google-antigravity/gemini-3.1-flash-image");
      assert.equal(body.input[0].content.length, 4);
      padded = Buffer.from(body.input[0].content[1].image_url.split(",")[1], "base64");
      const submittedMask = Buffer.from(body.input[0].content[2].image_url.split(",")[1], "base64");
      assert.deepEqual(await pixel(padded, 456 + 14, 340 + 4), [0, 0, 0, 0]);
      assert.deepEqual(await pixel(padded, 456 + 4, 340 + 4), [40, 100, 160, 255]);
      assert.deepEqual(await pixel(submittedMask, 456 + 14, 340 + 4), [255, 255, 255, 0]);
      assert.deepEqual(await pixel(submittedMask, 456 + 4, 340 + 4), [255, 255, 255, 255]);
      return Response.json(response("gemini-3.1-flash-image", "![image](/v1/opencodex/artifacts/img-result.png)"));
    }
    assert.equal(String(url), `${endpoint}/opencodex/artifacts/img-result.png`);
    assert.equal(init?.redirect, "error");
    return new Response(new Uint8Array(padded), { headers: { "content-type": "image/png" } });
  } });
  const result = await bridge!.invoke("gemini", await completionInput());
  assert.ok(result.ok);
  if (result.output.kind === "image") {
    assert.equal((await sharp(result.output.image).metadata()).width, 32);
    assert.deepEqual(await pixel(result.output.image, 14, 4), [0, 0, 0, 0]);
    assert.deepEqual(await pixel(result.output.image, 4, 4), [40, 100, 160, 255]);
  }
  assert.equal(calls, 3);
});

test("Gemini rejects arbitrary URLs, filesystem paths, traversal, and multiple images", async () => {
  for (const output of ["![image](https://evil.example/img.png)", "![image](/etc/private.png)", "![image](/v1/opencodex/artifacts/../private.png)", "![a](/v1/opencodex/artifacts/a.png) ![b](/v1/opencodex/artifacts/b.png)"]) {
    let calls = 0;
    const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url) => {
      calls++;
      if (String(url).endsWith("/models")) return Response.json({ data: models });
      return Response.json(response("gemini-3.1-flash-image", output));
    } });
    const result = await bridge!.invoke("gemini", await completionInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.status, "invalid_output");
    assert.equal(calls, 2);
  }
});

test("Gemini rejects multiple images split across response text parts", async () => {
  let calls = 0;
  const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url) => {
    calls++;
    if (String(url).endsWith("/models")) return Response.json({ data: models });
    return Response.json({ status: "completed", model: "gemini-3.1-flash-image", output: [{ type: "message", content: [
      { type: "output_text", text: "![image](/v1/opencodex/artifacts/a.png)" },
      { type: "output_text", text: "![image](/v1/opencodex/artifacts/b.png)" },
    ] }] });
  } });
  const result = await bridge!.invoke("gemini", await completionInput());
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
});

test("OpenAI completion never enters a globally redirected or unknown image route", async () => {
  for (const routing of [{ provider: "custom" }, { bridgeEnabled: true }, undefined]) {
    let calls = 0;
    const bridge = await discoverOpenCodexBridge({}, { discover, imageRouting: async () => routing, fetch: async () => {
      calls++;
      return Response.json({ data: models });
    } });
    assert.equal(bridge?.capabilities.openai.completion, false);
    const result = await bridge!.invoke("openai", await completionInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.status, "unavailable");
    assert.equal(calls, 1);
  }
});

test("OpenAI completion rechecks image routing before transmitting the source", async () => {
  let probes = 0;
  let calls = 0;
  const bridge = await discoverOpenCodexBridge({}, { discover, imageRouting: async () => ++probes === 1 ? {} : { provider: "custom" }, fetch: async () => {
    calls++;
    return Response.json({ data: models });
  } });
  assert.equal(bridge?.capabilities.openai.completion, true);
  const result = await bridge!.invoke("openai", await completionInput());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "unavailable");
  assert.equal(calls, 1);
});

test("analysis joins final text across separate messages before semantic validation", async () => {
  const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url) => String(url).endsWith("/models")
    ? Response.json({ data: models }) : Response.json({ status: "completed", model: "gemini-3.1-pro", output: [
      { type: "message", content: [{ type: "output_text", text: '{"lines":' }] },
      { type: "message", content: [{ type: "output_text", text: "[]}" }] },
    ] }) });
  const result = await createHostExecutors(bridge!).gemini.ocr!(await input());
  assert.ok(result.ok);
  assert.deepEqual(result.value, { lines: [] });
});

for (const provider of ["openai", "gemini"] as const) {
  for (const [name, details, expected] of [
    ["error", { error: { code: "server_error" } }, "invalid_output"],
    ["incomplete details", { incomplete_details: { reason: "max_output_tokens" } }, "invalid_output"],
    ["filtered error", { error: { code: "content_filter" } }, "policy_refused"],
    ["filtered incomplete details", { incomplete_details: { reason: "content_filter" } }, "policy_refused"],
    ["null fields", { error: null, incomplete_details: null }, "success"],
  ] as const) {
    test(`${provider} host completed envelope with ${name} preserves terminal classification`, async () => {
      const completed = { ...response("host-model", '{"lines":[]}'), ...details };
      const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url) => {
        if (String(url).endsWith("/models")) return Response.json({ data: models });
        return provider === "gemini" ? Response.json(completed) : new Response([
          `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: completed.output[0] })}\n\n`,
          `data: ${JSON.stringify({ type: "response.completed", response: { ...completed, output: [] } })}\n\n`,
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      } });
      const result = await createHostExecutors(bridge!)[provider].ocr!(await input());
      if (expected === "success") {
        assert.ok(result.ok);
        assert.deepEqual(result.value, { lines: [] });
      } else {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.failure.status, expected);
      }
    });
  }
}
