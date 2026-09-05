import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import { readAnalysisPackage } from "../src/analysis/package.js";
import {
  analyzeSlide,
  buildSlide,
} from "../src/pipeline.js";
import type { FileHostBridge } from "../src/providers/host-bridge.js";

const backgroundScene = JSON.stringify({
  nodes: [{
    id: "background", role: "background", bbox: [0, 0, 1000, 1000],
    confidence: 1, zIndex: 0, label: "canvas", extractionHints: [],
  }],
  relations: [],
});

test("API-only OpenAI analysis publishes effective models and actual routing attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-pipeline-"));
  const imagePath = join(directory, "slide.png");
  const analysisDir = join(directory, "analysis");
  await sharp({ create: { width: 64, height: 64, channels: 4, background: "white" } }).png().toFile(imagePath);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    const text = calls === 1
      ? JSON.stringify({ lines: [] })
      : JSON.stringify({
          nodes: [{ id: "background", role: "background", bbox: [0, 0, 1000, 1000], confidence: 1, zIndex: 0, label: "canvas", extractionHints: [] }],
          relations: [],
        });
    return new Response(JSON.stringify({
      status: "completed",
      model: calls === 1 ? "gpt-4.1-ocr-effective" : "gpt-4.1-scene-effective",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
    }), { status: 200 });
  };
  try {
    await analyzeSlide({
      imagePath,
      outDir: analysisDir,
      routingConfig: {
        openai: { apiKey: "openai-only-secret", analysisModel: "gpt-4.1", imageModel: "gpt-image-2" },
        requestTimeoutMs: 1000,
        maxAttempts: 1,
        maxRegionAnalysis: 0,
        maxOcclusionCompletions: 0,
      },
    });
    const ledger = await readAnalysisPackage(analysisDir);
    assert.equal(ledger.analysisVersion, 2);
    if (ledger.analysisVersion !== 2) return;
    assert.deepEqual(ledger.models, {
      ocr: "gpt-4.1-ocr-effective",
      fullVision: "gpt-4.1-scene-effective",
      regionalVision: "gpt-4.1-scene-effective",
    });
    assert.equal(ledger.routing?.version, 1);
    assert.deepEqual(
      ledger.routing?.operations.map((operation) => operation.selectedCandidate),
      ["api-openai", "api-openai"],
    );
    assert.equal(ledger.routing?.operations[0]?.attempts.length, 2);
    assert.deepEqual(ledger.routing?.transportAttempts, [
      { operation: "ocr", candidate: "api-openai", count: 1 },
      { operation: "scene", candidate: "api-openai", count: 1 },
    ]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("fatal routed analysis retains a safe routing report without provider secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-failure-"));
  const imagePath = join(directory, "slide.png");
  const outDir = join(directory, "analysis");
  await sharp({ create: { width: 64, height: 64, channels: 4, background: "white" } }).png().toFile(imagePath);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    output: [{ type: "message", content: [{ type: "refusal", refusal: "SECRET_PROVIDER_DETAIL" }] }],
  }), { status: 200 });
  try {
    await assert.rejects(analyzeSlide({
      imagePath,
      outDir,
      routingConfig: {
        openai: { apiKey: "SECRET_API_KEY", analysisModel: "gpt-4.1", imageModel: "gpt-image-2" },
        requestTimeoutMs: 1000,
        maxAttempts: 1,
        maxRegionAnalysis: 0,
        maxOcclusionCompletions: 0,
      },
    }), /Provider routing fatal/);
    const failedRoots = await import("node:fs/promises").then(({ readdir }) => readdir(`${outDir}.failed-runs`));
    assert.equal(failedRoots.length, 1);
    const report = await readFile(join(`${outDir}.failed-runs`, failedRoots[0]!, "routing-report.json"), "utf8");
    assert.match(report, /policy_refused/);
    assert.doesNotMatch(report, /SECRET_API_KEY|SECRET_PROVIDER_DETAIL/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("host-only analysis builds offline with no API credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-only-pipeline-"));
  const imagePath = join(directory, "slide.png");
  const analysisDir = join(directory, "analysis");
  const outputDir = join(directory, "output");
  await sharp({ create: { width: 64, height: 64, channels: 4, background: "white" } }).png().toFile(imagePath);
  const bridge: FileHostBridge = {
    capabilities: {
      openai: { ocr: true, scene: true, completion: false },
      gemini: { ocr: false, scene: false, completion: false },
    },
    async invoke(_provider, request) {
      return {
        ok: true,
        model: request.operation === "ocr" ? "host-ocr-model" : "host-scene-model",
        output: {
          kind: "text",
          text: request.operation === "ocr" ? "{\"lines\":[]}" : backgroundScene,
        },
      };
    },
  };
  try {
    await analyzeSlide({
      imagePath,
      outDir: analysisDir,
      routingConfig: {
        requestTimeoutMs: 100,
        maxAttempts: 1,
        maxRegionAnalysis: 0,
        maxOcclusionCompletions: 0,
      },
      hostBridge: bridge,
    });
    const ledger = await readAnalysisPackage(analysisDir);
    assert.equal(ledger.analysisVersion, 2);
    if (ledger.analysisVersion !== 2) return;
    assert.deepEqual(ledger.models, {
      ocr: "host-ocr-model",
      fullVision: "host-scene-model",
      regionalVision: "host-scene-model",
    });
    assert.deepEqual(
      ledger.routing?.operations.map(({ selectedCandidate }) => selectedCandidate),
      ["host-openai", "host-openai"],
    );

    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error("offline build attempted network access");
    };
    try {
      const built = await buildSlide({ analysisDir, outDir: outputDir });
      assert.equal(networkCalls, 0);
      await access(built.pptxPath);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
