import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { loadRoutingConfig } from "../src/config.js";
import { discoverOpenCodexBridge } from "../src/providers/opencodex-bridge.js";
import { createHostExecutors } from "../src/providers/provider-adapters.js";
import { ProviderRoutingSession, type RoutingAdapterFactory } from "../src/providers/provider-routing.js";
import { ProviderFailure } from "../src/providers/routing.js";

const capabilities = { openai: { ocr: true, scene: true, completion: true } };
const crop = () => sharp({ create: { width: 8, height: 8, channels: 4, background: "white" } }).png().toBuffer();

test("OpenCodex rejects direct completion without transmitting source or consulting image routing", async () => {
  let inferenceCalls = 0;
  let routingReads = 0;
  const bridge = await discoverOpenCodexBridge({}, {
    discover: async () => JSON.stringify({ baseUrl: "http://127.0.0.1:10100/v1" }),
    imageRouting: async () => { routingReads++; return {}; },
    fetch: async (url) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "gpt-5.6-sol", owned_by: "openai", capabilities: { supports_vision: true } }] });
      inferenceCalls++;
      return Response.json({ error: "must not send image edits" }, { status: 400 });
    },
  });
  assert.ok(bridge);
  const image = await crop();
  const result = await bridge.invoke("openai", { operation: "completion", image, canvas: { width: 8, height: 8 }, prompt: "complete", hiddenMask: image, protectedMask: image });
  assert.equal(inferenceCalls, 0);
  assert.equal(routingReads, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.status, "unavailable");
  assert.deepEqual(bridge.capabilities.openai, { ocr: true, scene: true, completion: false });
});

test("host adapter ignores stale completion declarations but preserves validated OCR", async () => {
  const calls: string[] = [];
  const executors = createHostExecutors({ capabilities, invoke: async (_provider, request) => {
    calls.push(request.operation);
    return { ok: true, model: "host-ocr", output: { kind: "text", text: '{"lines":[]}' } };
  } }).openai;
  assert.equal(executors.completion, undefined);
  const result = await executors.ocr!({ image: await crop(), canvas: { width: 8, height: 8 } });
  assert.ok(result.ok);
  assert.deepEqual(result.value, { lines: [] });
  assert.deepEqual(calls, ["ocr"]);
});

for (const apiOutcome of ["success", "auth_unavailable", "policy_refused"] as const) {
  test(`completion skips injected host and handles OpenAI ${apiOutcome} without changing OCR routing`, async () => {
    const calls: string[] = [];
    const image = await crop();
    const success = (model: string) => ({ ok: true as const, validated: true as const, model, value: { image, modelId: model, taskId: "test", sanitizedMetadata: {} } });
    const factory: RoutingAdapterFactory = {
      host: () => ({ openai: {
        completion: async () => { calls.push("host-completion"); return success("host-image"); },
        ocr: async () => { calls.push("host-ocr"); return { ok: true, validated: true, model: "host-ocr", value: { lines: [] } }; },
      } }),
      openai: () => ({ completion: async () => {
        calls.push("api-openai");
        return apiOutcome === "success" ? success("openai-image") : { ok: false, failure: new ProviderFailure(apiOutcome) };
      } }),
      alibaba: () => ({ completion: async () => { calls.push("api-alibaba"); return success("alibaba-image"); } }),
    };
    const session = new ProviderRoutingSession({ factory,
      routingConfig: loadRoutingConfig({ OPENAI_API_KEY: "test", DASHSCOPE_API_KEY: "test", DASHSCOPE_WORKSPACE_ID: "workspace-123" }),
      hostBridge: { capabilities, invoke: async () => assert.fail("injected adapters own transport") },
    });
    assert.equal((await session.ocr(image, { width: 8, height: 8 })).candidate, "host-openai");
    const request = { crop: image, hiddenMask: image, protectedVisibleMask: image, semanticContext: ["complete"] };
    if (apiOutcome === "policy_refused") {
      await assert.rejects(session.completionProvider().complete(request), /routing fatal/);
      assert.deepEqual(calls, ["host-ocr", "api-openai"]);
    } else {
      await session.completionProvider().complete(request);
      assert.deepEqual(calls, apiOutcome === "success" ? ["host-ocr", "api-openai"] : ["host-ocr", "api-openai", "api-alibaba"]);
      assert.equal(session.report.operations[1]?.selectedCandidate, apiOutcome === "success" ? "api-openai" : "api-alibaba");
    }
    assert.equal(session.transportAttempts.some(item => item.operation === "completion" && item.candidate === "host-openai"), false);
    assert.deepEqual(session.report.operations[1]?.attempts[0], { candidate: "host-openai", status: "unavailable", disposition: "missing_candidate" });
  });
}
