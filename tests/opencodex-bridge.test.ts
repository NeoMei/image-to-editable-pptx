import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { discoverOpenCodexBridge as discoverBridge } from "../src/providers/opencodex-bridge.js";
import { createHostExecutors } from "../src/providers/provider-adapters.js";
import { runCli } from "../src/cli.js";

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

const completionInput = async () => {
  const request = await input();
  const mask = async (background: string) => sharp({ create: { ...request.canvas, channels: 3, background } }).png().toBuffer();
  return { ...request, operation: "completion" as const, hiddenMask: await mask("white"), protectedMask: await mask("black") };
};

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
  const bridge = await discoverOpenCodexBridge({}, { discover, fetch: async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: models });
    assert.equal(String(url), `${endpoint}/images/edits`);
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "gpt-image-2");
    assert.equal(body.images.length, 3);
    assert.match(body.prompt, /alpha/);
    const image = Buffer.from(body.images[0].image_url.split(",")[1], "base64");
    return Response.json({ data: [{ b64_json: image.toString("base64") }] });
  } });
  const result = await bridge!.invoke("openai", await completionInput());
  assert.ok(result.ok);
  assert.equal(result.output.kind, "image");
  if (result.output.kind === "image") assert.equal((await sharp(result.output.image).metadata()).width, 32);
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
      return Response.json(response("gemini-3.1-flash-image", "![image](/v1/opencodex/artifacts/img-result.png)"));
    }
    assert.equal(String(url), `${endpoint}/opencodex/artifacts/img-result.png`);
    assert.equal(init?.redirect, "error");
    return new Response(new Uint8Array(padded), { headers: { "content-type": "image/png" } });
  } });
  const result = await bridge!.invoke("gemini", await completionInput());
  assert.ok(result.ok);
  if (result.output.kind === "image") assert.equal((await sharp(result.output.image).metadata()).width, 32);
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
