import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import type { ProviderRoutingConfig } from "../src/config.js";
import {
  ProviderRoutingSession,
  type RoutingAdapterFactory,
} from "../src/providers/provider-routing.js";
import { ProviderFailure } from "../src/providers/routing.js";

const routingConfig: ProviderRoutingConfig = {
  openai: { apiKey: "openai", analysisModel: "openai-analysis", imageModel: "openai-image" },
  gemini: { apiKey: "gemini", analysisModel: "gemini-analysis", imageModel: "gemini-image" },
  requestTimeoutMs: 1000,
  maxAttempts: 1,
  maxRegionAnalysis: 0,
  maxOcclusionCompletions: 0,
};

test("routing session wires host and API adapters in fixed order with independent operation state", async () => {
  const attempts: string[] = [];
  const unavailable = (name: string) => async () => {
    attempts.push(name);
    return { ok: false as const, failure: new ProviderFailure("unavailable") };
  };
  const factory: RoutingAdapterFactory = {
    host: () => ({
      openai: { ocr: unavailable("host-openai:ocr"), scene: unavailable("host-openai:scene") },
      gemini: { ocr: unavailable("host-gemini:ocr"), scene: unavailable("host-gemini:scene") },
    }),
    openai: () => ({
      ocr: unavailable("api-openai:ocr"),
      scene: async () => ({ ok: true, validated: true, model: "openai-effective", value: {
        graphVersion: 1 as const, canvas: { width: 8, height: 8 },
        nodes: [{ id: "background", role: "background" as const, bbox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1, zIndex: 0, label: "canvas", extractionHints: [] }],
        relations: [],
      } }),
    }),
    gemini: () => ({
      ocr: async () => ({ ok: true, validated: true, model: "gemini-effective", value: { lines: [] } }),
      scene: unavailable("api-gemini:scene"),
    }),
    alibaba: () => ({}),
  };
  const hostBridge = { capabilities: {
    openai: { ocr: true, scene: true, completion: false },
    gemini: { ocr: true, scene: true, completion: false },
  }, invoke: async () => assert.fail("factory owns the host double") } as never;
  const session = new ProviderRoutingSession({ routingConfig, hostBridge, factory });
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: "white" } }).png().toBuffer();

  const ocr = await session.ocr(image, { width: 8, height: 8 });
  const scene = await session.scene(image, { width: 8, height: 8 }, "scene");
  assert.deepEqual(ocr.value, { lines: [] });
  assert.equal(scene.model, "openai-effective");
  assert.deepEqual(attempts, [
    "host-openai:ocr", "api-openai:ocr", "host-gemini:ocr",
    "host-openai:scene",
  ]);
  assert.equal(session.report.operations[0]?.selectedCandidate, "api-gemini");
  assert.equal(session.report.operations[1]?.selectedCandidate, "api-openai");
});

test("routing session converts fatal and exhausted outcomes into typed terminal errors", async () => {
  const factory: RoutingAdapterFactory = {
    host: () => ({ openai: {}, gemini: {} }),
    openai: () => ({
      ocr: async () => ({ ok: false, failure: new ProviderFailure("policy_refused") }),
    }),
    gemini: () => ({}),
    alibaba: () => ({}),
  };
  const session = new ProviderRoutingSession({ routingConfig, factory });
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: "white" } }).png().toBuffer();
  await assert.rejects(
    session.ocr(image, { width: 8, height: 8 }),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, "RoutingTerminalError");
      return true;
    },
  );
  assert.equal(session.report.stopped, true);
});

test("routing session reaches Alibaba only after both host and API families advance", async () => {
  const calls: string[] = [];
  const unavailable = (name: string) => async () => {
    calls.push(name);
    return { ok: false as const, failure: new ProviderFailure("auth_unavailable") };
  };
  const factory: RoutingAdapterFactory = {
    host: () => ({
      openai: { ocr: unavailable("host-openai") },
      gemini: { ocr: unavailable("host-gemini") },
    }),
    openai: () => ({ ocr: unavailable("api-openai") }),
    gemini: () => ({ ocr: unavailable("api-gemini") }),
    alibaba: () => ({ ocr: async () => {
      calls.push("api-alibaba");
      return { ok: true, validated: true, model: "qwen3.5-ocr", value: { lines: [] } };
    } }),
  };
  const hostBridge = { capabilities: {
    openai: { ocr: true, scene: false, completion: false },
    gemini: { ocr: true, scene: false, completion: false },
  }, invoke: async () => assert.fail("factory owns host") } as never;
  const session = new ProviderRoutingSession({
    routingConfig: {
      ...routingConfig,
      alibaba: {
        apiKey: "alibaba", workspaceId: "workspace-123",
        dashscopeApiBase: "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1",
        dashscopeCompatibleBase: "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        ocrModel: "qwen3.5-ocr", visionModel: "qwen3-vl-plus",
        editModel: "wanx2.1-imageedit", requestTimeoutMs: 1000, pollIntervalMs: 1,
      },
    },
    hostBridge,
    factory,
  });
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: "white" } }).png().toBuffer();
  const result = await session.ocr(image, { width: 8, height: 8 });
  assert.equal(result.candidate, "api-alibaba");
  assert.deepEqual(calls, ["host-openai", "api-openai", "host-gemini", "api-gemini", "api-alibaba"]);
});
