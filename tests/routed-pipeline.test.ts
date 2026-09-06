import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import { readAnalysisPackage } from "../src/analysis/package.js";
import {
  COMPLETION_DIAGNOSTICS_NAME,
  CompletionDiagnosticsSchema,
} from "../src/occlusion/diagnostics.js";
import {
  analyzeSlide,
  buildSlide,
  runPipeline,
} from "../src/pipeline.js";
import type { FileHostBridge } from "../src/providers/host-bridge.js";
import { ProviderFailure } from "../src/providers/routing.js";

const backgroundScene = JSON.stringify({
  nodes: [{
    id: "background", role: "background", bbox: [0, 0, 1000, 1000],
    confidence: 1, zIndex: 0, label: "canvas", extractionHints: [],
  }],
  relations: [],
});

const OCCLUSION_WIDTH = 320;
const OCCLUSION_HEIGHT = 200;
const REAR_COLOR = [43, 109, 168, 255] as const;
const FRONT_COLOR = [230, 93, 22, 255] as const;
const BACKGROUND_COLOR = [247, 243, 233, 255] as const;

function paintRect(
  rgba: Buffer,
  bbox: { x: number; y: number; width: number; height: number },
  color: readonly [number, number, number, number],
): void {
  for (let y = bbox.y; y < bbox.y + bbox.height; y += 1) {
    for (let x = bbox.x; x < bbox.x + bbox.width; x += 1) {
      rgba.set(color, (y * OCCLUSION_WIDTH + x) * 4);
    }
  }
}

async function routedOcclusionFixture(): Promise<{
  image: Buffer;
  scene: string;
}> {
  const rgba = Buffer.alloc(OCCLUSION_WIDTH * OCCLUSION_HEIGHT * 4);
  for (let index = 0; index < OCCLUSION_WIDTH * OCCLUSION_HEIGHT; index += 1) {
    rgba.set(BACKGROUND_COLOR, index * 4);
  }
  const rear = { x: 140, y: 20, width: 40, height: 36 };
  const front = { x: 154, y: 28, width: 12, height: 20 };
  paintRect(rgba, rear, REAR_COLOR);
  paintRect(rgba, front, FRONT_COLOR);
  for (let y = 29; y < 39; y += 1) {
    rgba.set(BACKGROUND_COLOR, (y * OCCLUSION_WIDTH + 151) * 4);
  }
  const image = await sharp(rgba, {
    raw: { width: OCCLUSION_WIDTH, height: OCCLUSION_HEIGHT, channels: 4 },
  }).png().toBuffer();
  const normalized = (bbox: typeof rear) => [
    Math.round(bbox.x / OCCLUSION_WIDTH * 1000),
    Math.round(bbox.y / OCCLUSION_HEIGHT * 1000),
    Math.round((bbox.x + bbox.width) / OCCLUSION_WIDTH * 1000),
    Math.round((bbox.y + bbox.height) / OCCLUSION_HEIGHT * 1000),
  ];
  return {
    image,
    scene: JSON.stringify({
      nodes: [
        {
          id: "background",
          role: "background",
          bbox: [0, 0, 1000, 1000],
          confidence: 1,
          zIndex: 0,
          label: "complete canvas",
          extractionHints: [],
        },
        {
          id: "rear-object",
          role: "foreground-object",
          bbox: normalized(rear),
          confidence: 0.99,
          zIndex: 1,
          label: "uniform blue rear object",
          extractionHints: [],
        },
        {
          id: "front-object",
          role: "foreground-object",
          bbox: normalized(front),
          confidence: 0.99,
          zIndex: 2,
          label: "orange front object",
          extractionHints: [],
        },
      ],
      relations: [{
        id: "front-occludes-rear",
        kind: "occludes",
        from: "front-object",
        to: "rear-object",
        confidence: 0.99,
      }],
    }),
  };
}

async function residualOccluderReturn(
  request: Parameters<FileHostBridge["invoke"]>[1],
): Promise<Buffer> {
  assert.ok(request.hiddenMask);
  const [image, hidden] = await Promise.all([
    sharp(request.image).ensureAlpha().raw().toBuffer(),
    sharp(request.hiddenMask).greyscale().raw().toBuffer(),
  ]);
  for (let index = 0; index < hidden.length; index += 1) {
    if (hidden[index]! >= 16) image.set(FRONT_COLOR, index * 4);
  }
  return sharp(image, {
    raw: {
      width: request.canvas.width,
      height: request.canvas.height,
      channels: 4,
    },
  }).png().toBuffer();
}

async function acceptedCompletionReturn(
  request: Parameters<FileHostBridge["invoke"]>[1],
): Promise<Buffer> {
  assert.ok(request.hiddenMask);
  const [image, hidden] = await Promise.all([
    sharp(request.image).ensureAlpha().raw().toBuffer(),
    sharp(request.hiddenMask).greyscale().raw().toBuffer(),
  ]);
  const { width, height } = request.canvas;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (hidden[index]! < 16) continue;
      let rearOnRow = false;
      for (const direction of [-1, 1]) {
        for (let nextX = x + direction; nextX >= 0 && nextX < width; nextX += direction) {
          const nextOffset = (y * width + nextX) * 4;
          if (image[nextOffset + 3] === 0) continue;
          rearOnRow =
            image[nextOffset] === REAR_COLOR[0] &&
            image[nextOffset + 1] === REAR_COLOR[1] &&
            image[nextOffset + 2] === REAR_COLOR[2];
          break;
        }
        if (rearOnRow) break;
      }
      image.set(rearOnRow ? REAR_COLOR : BACKGROUND_COLOR, index * 4);
    }
  }
  return sharp(image, {
    raw: { width, height, channels: 4 },
  }).png().toBuffer();
}

function routedOcclusionBridge(options: {
  fixture: Awaited<ReturnType<typeof routedOcclusionFixture>>;
  calls?: string[];
}): FileHostBridge {
  return {
    capabilities: {
      openai: { ocr: true, scene: true, completion: true },
    },
    async invoke(provider, request) {
      options.calls?.push(`${provider}:${request.operation}`);
      if (request.operation === "ocr") {
        return {
          ok: true,
          model: `${provider}-ocr-model`,
          output: { kind: "text", text: "{\"lines\":[]}" },
        };
      }
      if (request.operation === "scene") {
        return {
          ok: true,
          model: `${provider}-scene-model`,
          output: { kind: "text", text: options.fixture.scene },
        };
      }
      assert.fail("host completion must never be invoked");
    },
  };
}


function installCompletionApi(options: {
  completionFailure?: ProviderFailure;
  completionMode?: "accepted" | "residual";
  onCompletion?: () => Promise<void>;
  calls?: string[];
} = {}): void {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/images/edits");
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    options.calls?.push("api-openai:completion");
    if (options.completionFailure) return Response.json({ error: { code: "content_filter", message: "policy refused" } }, { status: 400 });
    await options.onCompletion?.();
    const form = init.body;
    const sourceFile = form.get("image") as Blob;
    const maskFile = form.get("mask") as Blob;
    const image = Buffer.from(await sourceFile.arrayBuffer());
    const alpha = await sharp(Buffer.from(await maskFile.arrayBuffer())).extractChannel("alpha").raw().toBuffer({ resolveWithObject: true });
    const hidden = await sharp(Buffer.from(alpha.data.map(value => 255 - value)), { raw: { width: alpha.info.width, height: alpha.info.height, channels: 1 } }).png().toBuffer();
    const match = /original crop occupies x=(\d+), y=(\d+), width=(\d+), height=(\d+)/.exec(String(form.get("prompt")));
    assert.ok(match);
    const [left, top, width, height] = match.slice(1).map(Number) as [number, number, number, number];
    const request = {
      operation: "completion" as const, prompt: "", canvas: { width, height },
      image: await sharp(image).extract({ left, top, width, height }).png().toBuffer(),
      hiddenMask: await sharp(hidden).extract({ left, top, width, height }).png().toBuffer(),
    };
    const completed = options.completionMode === "accepted"
      ? await acceptedCompletionReturn(request) : await residualOccluderReturn(request);
    const padded = await sharp(completed).extend({
      left, top, right: alpha.info.width - left - width, bottom: alpha.info.height - top - height,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png().toBuffer();
    return Response.json({ data: [{ b64_json: padded.toString("base64") }] });
  };
}

const completionApiConfig = { apiKey: "test-only-key", analysisModel: "test-analysis", imageModel: "gpt-image-2" };

const routedOcclusionConfig = {
  requestTimeoutMs: 100,
  maxAttempts: 1,
  maxRegionAnalysis: 0,
  maxOcclusionCompletions: 1,
} as const;

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

      // Retired provider names in historical provenance never become live
      // execution instructions, but must not invalidate a self-contained v2.
      assert.ok(ledger.routing);
      const historicalLedger = {
        ...ledger,
        routing: {
          ...ledger.routing,
          transportAttempts: ledger.routing.transportAttempts.map((entry) => ({ ...entry, candidate: "host-gemini" })),
          operations: ledger.routing.operations.map((entry) => ({
            ...entry,
            selectedCandidate: "host-gemini",
            attempts: entry.attempts.map((attempt) => ({ ...attempt, candidate: "host-gemini" })),
          })),
        },
      };
      await writeFile(join(analysisDir, "analysis-ledger.json"), JSON.stringify(historicalLedger));
      const historical = await readAnalysisPackage(analysisDir);
      assert.equal(historical.analysisVersion, 2);
      const rebuilt = await buildSlide({ analysisDir, outDir: join(directory, "historical-output") });
      await access(rebuilt.pptxPath);
      assert.equal(networkCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("host-only occlusion analysis preserves the background when completion APIs are absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "host-completion-disabled-"));
  const fixture = await routedOcclusionFixture();
  const calls: string[] = [];
  const imagePath = join(directory, "source.png");
  const analysisDir = join(directory, "analysis");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => assert.fail("host-only analysis must not contact any API");
    await writeFile(imagePath, fixture.image);
    await analyzeSlide({ imagePath, outDir: analysisDir, routingConfig: routedOcclusionConfig, hostBridge: routedOcclusionBridge({ fixture, calls }) });
    assert.deepEqual(calls, ["openai:ocr", "openai:scene"]);
    const ledger = await readAnalysisPackage(analysisDir);
    assert.equal(ledger.analysisVersion, 2);
    if (ledger.analysisVersion !== 2) return;
    assert.equal(ledger.completions.length, 0);
    assert.deepEqual(ledger.routing?.transportAttempts.filter(item => item.operation === "completion"), []);
    const completion = ledger.routing?.operations.find(item => item.operation === "completion");
    assert.equal(completion?.outcome, "exhausted");
    assert.ok(completion?.attempts.every(item => item.status === "unavailable" && item.disposition === "missing_candidate"));
    const diagnostics = CompletionDiagnosticsSchema.parse(JSON.parse(await readFile(join(analysisDir, COMPLETION_DIAGNOSTICS_NAME), "utf8")));
    assert.equal(diagnostics.candidates[0]?.status, "skipped");
    const outputDir = join(directory, "output");
    const built = await buildSlide({ analysisDir, outDir: outputDir });
    await access(built.pptxPath);
    const background = await sharp(join(outputDir, "clean-background.png")).ensureAlpha().raw().toBuffer();
    assert.deepEqual([...background.subarray((24 * OCCLUSION_WIDTH + 145) * 4, (24 * OCCLUSION_WIDTH + 145) * 4 + 4)], [...REAR_COLOR]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("records routed transport success separately from quality rejection without fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-quality-rejection-"));
  const imagePath = join(directory, "slide.png");
  const analysisDir = join(directory, "analysis");
  const outputDir = join(directory, "output");
  const fixture = await routedOcclusionFixture();
  const calls: string[] = [];
  await writeFile(imagePath, fixture.image, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  try {
    installCompletionApi({ calls });
    await analyzeSlide({
      imagePath,
      outDir: analysisDir,
      routingConfig: { ...routedOcclusionConfig, openai: completionApiConfig },
      hostBridge: routedOcclusionBridge({ fixture, calls }),
    });

    const ledger = await readAnalysisPackage(analysisDir);
    assert.equal(ledger.analysisVersion, 2);
    if (ledger.analysisVersion !== 2) return;
    assert.equal(ledger.requests.completion, 1);
    assert.equal(ledger.completions.length, 0);
    assert.equal(calls.filter((call) => call.endsWith(":completion")).length, 1);
    assert.deepEqual(
      calls.filter((call) => call.endsWith(":completion")),
      ["api-openai:completion"],
    );
    const routedCompletion = ledger.routing?.operations.find(
      ({ operation }) => operation === "completion",
    );
    assert.equal(routedCompletion?.outcome, "success");
    assert.equal(routedCompletion?.selectedCandidate, "api-openai");
    assert.deepEqual(
      ledger.routing?.transportAttempts.filter(
        ({ operation }) => operation === "completion",
      ),
      [{ operation: "completion", candidate: "api-openai", count: 1 }],
    );
    const diagnostics = CompletionDiagnosticsSchema.parse(JSON.parse(
      await readFile(join(analysisDir, COMPLETION_DIAGNOSTICS_NAME), "utf8"),
    ));
    assert.deepEqual(diagnostics.candidates.map((candidate) => ({
      sequence: candidate.sequence,
      status: candidate.status,
      ...("reason" in candidate ? { reason: candidate.reason } : {}),
    })), [{
      sequence: 0,
      status: "rejected",
      reason: "residual_occluder",
    }]);

    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error("offline build attempted network access");
    };
    const built = await buildSlide({ analysisDir, outDir: outputDir });
    assert.equal(networkCalls, 0);
    await access(built.pptxPath);
    await assert.rejects(access(join(outputDir, "completions")), /ENOENT/);
    const background = await sharp(join(outputDir, "clean-background.png"))
      .ensureAlpha()
      .raw()
      .toBuffer();
    assert.deepEqual(
      [...background.subarray((24 * OCCLUSION_WIDTH + 145) * 4, (24 * OCCLUSION_WIDTH + 145) * 4 + 4)],
      [...REAR_COLOR],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal completion refusal aborts analysis instead of becoming a quality rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-completion-refusal-"));
  const imagePath = join(directory, "slide.png");
  const outDir = join(directory, "analysis");
  const fixture = await routedOcclusionFixture();
  const calls: string[] = [];
  await writeFile(imagePath, fixture.image, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  try {
    installCompletionApi({ calls, completionFailure: new ProviderFailure("policy_refused") });
    await assert.rejects(
      analyzeSlide({
        imagePath,
        outDir,
        routingConfig: { ...routedOcclusionConfig, openai: completionApiConfig },
        hostBridge: routedOcclusionBridge({
          fixture,
          calls,
        }),
      }),
      /Provider routing fatal for completion/,
    );
    assert.deepEqual(
      calls.filter((call) => call.endsWith(":completion")),
      ["api-openai:completion"],
    );
    const failedRuns = await readdir(`${outDir}.failed-runs`);
    assert.equal(failedRuns.length, 1);
    const failed = join(`${outDir}.failed-runs`, failedRuns[0]!);
    const report = await readFile(join(failed, "routing-report.json"), "utf8");
    assert.match(report, /"outcome": "fatal"/);
    assert.match(report, /"operation": "completion"/);
    assert.match(report, /"status": "policy_refused"/);
    await assert.rejects(
      access(join(failed, COMPLETION_DIAGNOSTICS_NAME)),
      /ENOENT/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("actual evaluated completion survives analysis publication and offline build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-completion-success-"));
  const imagePath = join(directory, "slide.png");
  const analysisDir = join(directory, "analysis");
  const outputDir = join(directory, "output");
  const fixture = await routedOcclusionFixture();
  await writeFile(imagePath, fixture.image, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  try {
    installCompletionApi({ completionMode: "accepted" });
    await analyzeSlide({
      imagePath,
      outDir: analysisDir,
      routingConfig: { ...routedOcclusionConfig, openai: completionApiConfig },
      hostBridge: routedOcclusionBridge({
        fixture,
      }),
    });
    const ledger = await readAnalysisPackage(analysisDir);
    assert.equal(ledger.analysisVersion, 2);
    if (ledger.analysisVersion !== 2) return;
    assert.equal(ledger.requests.completion, 1);
    assert.equal(ledger.completions.length, 1);
    assert.equal(ledger.completions[0]?.reviewRequired, true);
    const diagnostics = CompletionDiagnosticsSchema.parse(JSON.parse(
      await readFile(join(analysisDir, COMPLETION_DIAGNOSTICS_NAME), "utf8"),
    ));
    assert.equal(diagnostics.candidates[0]?.sequence, 0);
    assert.equal(diagnostics.candidates[0]?.status, "accepted");
    await assert.rejects(access(join(analysisDir, "raw-responses")), /ENOENT/);

    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error("offline build attempted network access");
    };
    const built = await buildSlide({ analysisDir, outDir: outputDir });
    assert.equal(networkCalls, 0);
    const manifest = JSON.parse(await readFile(built.manifestPath, "utf8")) as {
      elements: Array<{
        id: string;
        kind: string;
        reviewRequired?: boolean;
        provenance?: { kind?: string };
      }>;
    };
    const rear = manifest.elements.find(({ id }) => id === "rear-object");
    assert.deepEqual({
      kind: rear?.kind,
      reviewRequired: rear?.reviewRequired,
      provenance: rear?.provenance?.kind,
    }, {
      kind: "asset",
      reviewRequired: true,
      provenance: "composite",
    });
    await assert.rejects(
      access(join(outputDir, COMPLETION_DIAGNOSTICS_NAME)),
      /ENOENT/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("completion diagnostics publication failure preserves earlier output and foreign targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routed-diagnostics-failure-"));
  const imagePath = join(directory, "slide.png");
  const outputDir = join(directory, "output");
  const fixture = await routedOcclusionFixture();
  const external = join(directory, "foreign-diagnostics.json");
  await writeFile(imagePath, fixture.image, { mode: 0o600 });
  await writeFile(external, "foreign diagnostics remain unchanged\n", { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  try {
    installCompletionApi({ onCompletion: async () => {
      const stagingName = (await readdir(directory)).find(name => name.startsWith(".output.staging-"));
      assert.ok(stagingName);
      await symlink(external, join(directory, stagingName, COMPLETION_DIAGNOSTICS_NAME));
    } });
    await runPipeline({
      imagePath,
      outDir: outputDir,
      routingConfig: { ...routedOcclusionConfig, maxOcclusionCompletions: 0 },
      hostBridge: routedOcclusionBridge({ fixture }),
    });
    const before = await readFile(join(outputDir, "analysis-ledger.json"));

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir: outputDir,
        routingConfig: { ...routedOcclusionConfig, openai: completionApiConfig },
        hostBridge: routedOcclusionBridge({
          fixture,
        }),
      }),
      /completion diagnostics/i,
    );
    assert.deepEqual(await readFile(join(outputDir, "analysis-ledger.json")), before);
    assert.equal(
      await readFile(external, "utf8"),
      "foreign diagnostics remain unchanged\n",
    );
    assert.deepEqual(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".output.staging-"),
      ),
      [],
    );
    const failedRuns = await readdir(`${outputDir}.failed-runs`);
    assert.equal(failedRuns.length, 1);
    const failedSidecar = join(
      `${outputDir}.failed-runs`,
      failedRuns[0]!,
      COMPLETION_DIAGNOSTICS_NAME,
    );
    assert.equal(
      await (await import("node:fs/promises")).lstat(failedSidecar).then(
        (info) => info.isSymbolicLink(),
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
