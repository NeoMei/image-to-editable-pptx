import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, win32 } from "node:path";
import test from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import type { AppConfig } from "../src/config.js";
import {
  readAnalysisPackage,
  writeAnalysisPackageV2,
  type AnalysisPackageV2,
} from "../src/analysis/package.js";
import type {
  CandidateDecision,
  FidelityPlan,
  OcrResult,
  SlideElement,
} from "../src/contracts.js";
import { readSemanticAssetPublication } from "../src/fidelity/build.js";
import {
  chooseSemanticMask,
  deriveSemanticMasks,
} from "../src/image/semantic-mask.js";
import type { SourceCanvas } from "../src/image/source.js";
import {
  analyzeSlide,
  buildSlide,
  OUTPUT_OWNERSHIP_MARKER,
  resolveSafeAssetOutputPath,
  runPipeline,
  type FidelityBuild,
} from "../src/pipeline.js";
import type { SceneGraph } from "../src/scene/contracts.js";
import { planSemanticLayers } from "../src/scene/plan.js";

const liveConfig: AppConfig = {
  apiKey: "provider-secret-canary",
  workspaceId: "workspace-123",
  dashscopeApiBase:
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1",
  dashscopeCompatibleBase:
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ocrModel: "qwen3.5-ocr",
  visionModel: "qwen3-vl-plus",
  editModel: "wanx2.1-imageedit",
  requestTimeoutMs: 120_000,
  pollIntervalMs: 0,
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function snapshotTree(
  directory: string,
  prefix = "",
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      snapshot[`${relativePath}/`] = "directory";
      Object.assign(snapshot, await snapshotTree(path, relativePath));
    } else {
      snapshot[relativePath] = (await readFile(path)).toString("base64");
    }
  }
  return snapshot;
}

async function collectJsonPaths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await collectJsonPaths(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) paths.push(path);
  }
  return paths;
}

async function writeNormalizedReplay(
  directory: string,
  ocr: unknown,
  vision: unknown,
): Promise<{ ocrPath: string; visionPath: string }> {
  const ocrPath = join(directory, "normalized-ocr.json");
  const visionPath = join(directory, "normalized-vision.json");
  await Promise.all([
    writeFile(ocrPath, JSON.stringify(ocr), "utf8"),
    writeFile(visionPath, JSON.stringify(vision), "utf8"),
  ]);
  return { ocrPath, visionPath };
}

function oversizedInvalidJsonBody(provider: "ocr" | "vision"): string {
  return [
    `not-json-${provider}`,
    liveConfig.apiKey,
    "Authorization: Bearer sk-round2-credential-1234567890",
    "api_key=LTAI0123456789ABCDEF",
    '"apiKey":"quoted-round2-secret-1234567890"',
    '"Authorization":"Bearer quoted-round2-bearer-1234567890"',
    "x".repeat(70_000),
  ].join(" ");
}

const repairMetrics = {
  maskedPixels: 4,
  outsideMaskChangedPixels: 0,
  ringSamples: 20,
  ringChannelMad: 1,
  filledPixelDistanceP95: 2,
};

test("resolves portable manifest asset paths with Windows path semantics", () => {
  assert.equal(
    resolveSafeAssetOutputPath(
      "C:\\workspace\\published-output",
      "assets/asset-node.png",
      win32,
    ),
    "C:\\workspace\\published-output\\assets\\asset-node.png",
  );
  assert.throws(
    () =>
      resolveSafeAssetOutputPath(
        "C:\\workspace\\published-output",
        "assets\\asset-node.png",
        win32,
      ),
    /Unsafe generated asset path/,
  );
  assert.throws(
    () =>
      resolveSafeAssetOutputPath(
        "C:\\workspace\\published-output",
        "assets/../outside.png",
        win32,
      ),
    /Unsafe generated asset path/,
  );
});

const recompositionMetrics = {
  comparedPixels: 100,
  meanAbsoluteError: 0,
  p95ChannelDelta: 0,
  changedPixelRatio: 0,
};

const deterministicFidelityBuild: FidelityBuild = async (source, plan) => {
  const elements: SlideElement[] = [
    ...plan.text.map((candidate) => candidate.element),
    ...plan.icons.map((candidate) => ({
      kind: "asset" as const,
      id: candidate.id,
      label: candidate.label,
      bbox: candidate.bbox,
      extraction: "transparent" as const,
      assetPath: `assets/${candidate.id}.png`,
      zIndex: candidate.zIndex,
    })),
  ].sort((left, right) => left.zIndex - right.zIndex);
  const decisions: CandidateDecision[] = [
    ...plan.text.map((candidate) => ({
      candidateId: candidate.id,
      kind: "text" as const,
      decision: "accepted" as const,
      bbox: candidate.element.bbox,
      sourceElementIndexes: [],
      repairMethod: "local_nearest_surface" as const,
      extraction: "none" as const,
      repairMetrics,
      output: {
        state: "editable_layer" as const,
        manifestElementId: candidate.element.id,
      },
    })),
    ...plan.icons.map((candidate) => ({
      candidateId: candidate.id,
      kind: "icon" as const,
      decision: "accepted" as const,
      bbox: candidate.bbox,
      sourceElementIndexes: candidate.sourceElementIndexes,
      repairMethod: "local_nearest_surface" as const,
      extraction: "transparent" as const,
      repairMetrics,
      recompositionMetrics,
      output: {
        state: "editable_layer" as const,
        manifestElementId: candidate.id,
        assetPath: `assets/${candidate.id}.png`,
      },
    })),
  ];
  const combinedMask = await sharp(Buffer.alloc(plan.canvas.width * plan.canvas.height), {
    raw: { ...plan.canvas, channels: 1 },
  }).png().toBuffer();
  return {
    background: source,
    combinedMask,
    manifest: {
      manifestVersion: 1,
      canvas: plan.canvas,
      elements,
      warnings: plan.warnings,
    },
    assets: new Map(
      plan.icons.map((candidate) => [
        `assets/${candidate.id}.png`,
        source,
      ]),
    ),
    decisions,
  };
};

const failingFidelityBuild = (message: string): FidelityBuild =>
  async (_source: Buffer, _plan: FidelityPlan) => {
    throw new Error(message);
  };

test("runs the complete pipeline from recorded provider fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "artifacts");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);

    let fidelityBuildCalls = 0;
    const result = await runPipeline({
      imagePath,
      outDir,
      replay: {
        ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
        visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
      },
      fidelityBuild: async (...args) => {
        fidelityBuildCalls += 1;
        return deterministicFidelityBuild(...args);
      },
    });

    const expectedFiles = [
      "ocr.json",
      "vision.json",
      "manifest.json",
      "removal-mask.png",
      "clean-background.png",
      "run-ledger.json",
      "slide-07-editable.pptx",
    ];
    await Promise.all(
      expectedFiles.map((name) => access(join(outDir, name))),
    );
    await access(join(outDir, "assets"));

    const manifest = JSON.parse(
      await readFile(join(outDir, "manifest.json"), "utf8"),
    ) as {
      elements: Array<{ kind: string; label?: string; extraction?: string }>;
    };
    const nativeShapeLabels = manifest.elements
      .filter((element) => element.kind === "shape")
      .map((element) => element.label)
      .sort();
    assert.equal(fidelityBuildCalls, 1);
    assert.equal(nativeShapeLabels.length, 0);
    assert.equal(
      manifest.elements.filter((element) => element.kind === "text").length,
      10,
    );
    assert.ok(
      manifest.elements
        .filter((element) => element.kind === "asset")
        .every((element) => element.extraction === "transparent"),
    );

    const ledgerText = await readFile(
      join(outDir, "run-ledger.json"),
      "utf8",
    );
    const ledger = JSON.parse(ledgerText) as {
      mode: string;
      models: Record<string, string>;
      durationsMs: Record<string, number>;
      taskIds: Record<string, string>;
      warnings: string[];
      ledgerVersion: number;
      decisions: Array<{ kind: string }>;
      hashes: Record<string, unknown>;
      outputs: Record<string, string>;
    };
    assert.equal(ledger.mode, "replay");
    assert.deepEqual(ledger.models, {
      ocr: "qwen3.5-ocr",
      vision: "qwen3-vl-plus",
    });
    assert.ok(
      Object.values(ledger.durationsMs).every(
        (duration) => Number.isFinite(duration) && duration >= 0,
      ),
    );
    assert.equal(ledger.ledgerVersion, 2);
    assert.equal(ledger.taskIds.wanx, undefined);
    assert.equal(ledger.decisions.filter((item) => item.kind === "text").length, 10);
    assert.ok(Array.isArray(ledger.warnings));
    assert.equal(typeof ledger.hashes.sourceImage, "string");
    assert.equal(typeof ledger.hashes.pptx, "string");
    assert.equal(
      ledger.outputs.pptx,
      result.pptxPath,
    );
    assert.doesNotMatch(
      ledgerText,
      /authorization|api[_-]?key|access[_-]?token|bearer/i,
    );

    const archive = await JSZip.loadAsync(
      await readFile(result.pptxPath),
    );
    const slideXml = await archive
      .file("ppt/slides/slide1.xml")!
      .async("string");
    assert.match(slideXml, /<a:t>第 4 章 工具<\/a:t>/);
    assert.doesNotMatch(slideXml, /name="shape-/);
    if (process.platform !== "win32") {
      const generatedJson = await collectJsonPaths(outDir);
      assert.ok(generatedJson.length >= 5);
      for (const path of generatedJson) {
        assert.equal((await stat(path)).mode & 0o777, 0o600, path);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts a JPEG source even when it has a PNG extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-source-format-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "analysis");

  try {
    const jpeg = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .jpeg()
      .toBuffer();
    await writeFile(imagePath, jpeg);

    const result = await runPipeline({
      imagePath,
      outDir,
      replay: {
        ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
        visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
      },
      fidelityBuild: deterministicFidelityBuild,
    });
    await access(result.pptxPath);
    const ledger = JSON.parse(await readFile(result.ledgerPath, "utf8")) as {
      hashes: { sourceImage: string };
    };
    assert.equal(ledger.hashes.sourceImage.length, 64);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an invalid source before invoking OCR or Vision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-invalid-source-"));
  const imagePath = join(directory, "source.png");
  const outDir = join(directory, "analysis");
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("Provider must not be called for invalid input");
  };

  try {
    await writeFile(imagePath, Buffer.from("not an image"));

    await assert.rejects(
      analyzeSlide({ imagePath, outDir, config: liveConfig }),
      /PNG or JPEG/i,
    );
    assert.equal(providerCalls, 0);
    await assert.rejects(access(outDir));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("live analyze records one OCR, one full Vision, bounded regional Vision, and disabled completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-v2-live-analysis-"));
  const imagePath = join(directory, "source.png");
  const analysisDir = join(directory, "analysis");
  const originalFetch = globalThis.fetch;
  let ocrCalls = 0;
  let fullVisionCalls = 0;
  let regionalVisionCalls = 0;

  try {
    await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 4,
        background: "#f7f3e9",
      },
    }).png().toFile(imagePath);
    const [ocrFixture, sceneFixture] = await Promise.all([
      readFile(resolve("tests/fixtures/qwen-ocr-slide-07.json"), "utf8").then(JSON.parse),
      readFile(resolve("tests/fixtures/qwen-scene-generic.json"), "utf8").then(JSON.parse),
    ]);
    const boundedConfig: AppConfig = {
      ...liveConfig,
      maxRegionAnalysis: 1,
      maxOcclusionCompletions: 0,
    };

    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/chat/completions")) {
        const request = JSON.parse(String(init?.body)) as {
          messages: Array<{
            content: Array<{ type: string; text?: string }>;
          }>;
        };
        const prompt = request.messages[0]?.content.find(
          ({ type }) => type === "text",
        )?.text ?? "";
        if (prompt.includes("supplied regional crop")) regionalVisionCalls += 1;
        else fullVisionCalls += 1;
        return Response.json(sceneFixture);
      }
      ocrCalls += 1;
      return Response.json(ocrFixture);
    };

    await analyzeSlide({
      imagePath,
      outDir: analysisDir,
      config: boundedConfig,
    });

    assert.deepEqual(
      { ocrCalls, fullVisionCalls, regionalVisionCalls },
      { ocrCalls: 1, fullVisionCalls: 1, regionalVisionCalls: 1 },
    );
    const packageLedger = await readAnalysisPackage(analysisDir);
    assert.equal(packageLedger.analysisVersion, 2);
    assert.deepEqual(packageLedger.requests, {
      ocr: 1,
      fullVision: 1,
      regionalVision: 1,
      completion: 0,
    });
    assert.equal(packageLedger.refinements.length, 1);
    assert.equal(packageLedger.completions.length, 0);
    const ledgerText = await readFile(
      join(analysisDir, "analysis-ledger.json"),
      "utf8",
    );
    assert.doesNotMatch(
      ledgerText,
      /provider-secret-canary|data:image|base64|authorization|signed[_-]?url/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("integrated live run consumes and preserves its verified v2 staging package", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-v2-live-run-"));
  const imagePath = join(directory, "source.png");
  const outDir = join(directory, "output");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 4,
        background: "#f7f3e9",
      },
    }).png().toFile(imagePath);
    const [ocrFixture, sceneFixture] = await Promise.all([
      readFile(resolve("tests/fixtures/qwen-ocr-slide-07.json"), "utf8").then(JSON.parse),
      readFile(resolve("tests/fixtures/qwen-scene-generic.json"), "utf8").then(JSON.parse),
    ]);
    ocrFixture.output.choices[0].message.content[0].ocr_result.words_info = [];
    globalThis.fetch = async (input) => {
      fetchCalls += 1;
      return Response.json(
        String(input).endsWith("/chat/completions")
          ? sceneFixture
          : ocrFixture,
      );
    };

    const result = await runPipeline({
      imagePath,
      outDir,
      config: {
        ...liveConfig,
        maxRegionAnalysis: 0,
        maxOcclusionCompletions: 0,
      },
    });

    assert.equal(fetchCalls, 2);
    assert.equal(result.pptxPath.endsWith("/output/slide-editable.pptx"), true);
    const packageLedger = await readAnalysisPackage(outDir);
    assert.equal(packageLedger.analysisVersion, 2);
    await Promise.all([
      access(join(outDir, "source.rgba")),
      access(join(outDir, "scene-graph.json")),
      access(result.pptxPath),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a source image replaced between integrated analysis and build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-source-race-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    const [analyzedSource, replacementSource] = await Promise.all([
      sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 3,
          background: "#f7f3e9",
        },
      }).png().toBuffer(),
      sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 3,
          background: "#23394d",
        },
      }).png().toBuffer(),
    ]);
    await writeFile(imagePath, analyzedSource);

    const replay = {
      get ocrPath(): string {
        writeFileSync(imagePath, replacementSource);
        return resolve("tests/fixtures/qwen-ocr-slide-07.json");
      },
      visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
    };

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay,
        fidelityBuild: deterministicFidelityBuild,
      }),
      /Analysis provenance hash mismatch: sourceImage/,
    );
    await assert.rejects(access(outDir));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves live-like analysis provenance through a split build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-split-"));
  const imagePath = join(directory, "slide-07.png");
  const analysisDir = join(directory, "analysis");
  const outDir = join(directory, "output");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    await analyzeSlide({
      imagePath,
      outDir: analysisDir,
      replay: {
        ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
        visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
      },
    });
    const analysisLedgerPath = join(analysisDir, "analysis-ledger.json");
    const analysisLedger = JSON.parse(
      await readFile(analysisLedgerPath, "utf8"),
    ) as {
      mode: string;
      models: Record<string, string>;
      durationsMs: Record<string, number>;
      warnings: string[];
      recorded: boolean;
    };
    await writeFile(
      analysisLedgerPath,
      `${JSON.stringify(
        {
          ...analysisLedger,
          mode: "live",
          models: {
            ocr: "live-ocr-model",
            vision: "live-vision-model",
            edit: "live-edit-model",
          },
          durationsMs: { ocr: 11, vision: 22, analyze: 33 },
          warnings: ["live-analysis-warning"],
          recorded: false,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await buildSlide({
      imagePath,
      analysisDir,
      outDir,
      fidelityBuild: deterministicFidelityBuild,
    });

    await Promise.all([
      access(join(outDir, "ocr.json")),
      access(join(outDir, "vision.json")),
      access(join(outDir, "analysis-ledger.json")),
      access(result.ledgerPath),
      access(result.pptxPath),
    ]);
    const ledger = JSON.parse(
      await readFile(result.ledgerPath, "utf8"),
    ) as {
      mode: string;
      recorded: boolean;
      models: Record<string, string>;
      durationsMs: Record<string, number>;
      warnings: string[];
    };
    assert.equal(ledger.mode, "live");
    assert.equal(ledger.recorded, false);
    assert.deepEqual(ledger.models, {
      ocr: "live-ocr-model",
      vision: "live-vision-model",
    });
    assert.equal(ledger.durationsMs.ocr, 11);
    assert.equal(ledger.durationsMs.vision, 22);
    assert.equal(ledger.durationsMs.analyze, 33);
    assert.ok(ledger.warnings.includes("live-analysis-warning"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("builds offline from verified v2 RGBA and restores its Chinese QA glyph", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-v2-offline-"));
  const analysisDir = join(directory, "analysis");
  const outDir = join(directory, "output");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    await mkdir(analysisDir);
    const width = 320;
    const height = 200;
    const rgba = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      rgba.set([247, 243, 233, 255], index * 4);
    }
    const rear = { x: 140, y: 20, width: 40, height: 36 };
    const front = { x: 154, y: 28, width: 12, height: 20 };
    const paint = (
      bbox: typeof rear,
      color: readonly [number, number, number, number],
    ): void => {
      for (let y = bbox.y; y < bbox.y + bbox.height; y += 1) {
        for (let x = bbox.x; x < bbox.x + bbox.width; x += 1) {
          rgba.set(color, (y * width + x) * 4);
        }
      }
    };
    paint(rear, [43, 109, 168, 255]);
    paint(front, [230, 93, 22, 255]);
    const textBox = { x: 40, y: 120, width: 24, height: 20 };
    for (let y = 123; y <= 137; y += 1) {
      rgba.set([35, 57, 77, 255], (y * width + 60) * 4);
    }
    for (let x = 52; x <= 61; x += 1) {
      rgba.set([35, 57, 77, 255], (130 * width + x) * 4);
    }
    const sourceBytes = await sharp(rgba, {
      raw: { width, height, channels: 4 },
    }).png().toBuffer();
    const canvas: SourceCanvas = {
      format: "png",
      width,
      height,
      rgba,
      sourceBytes,
    };
    const packageOcr: OcrResult = {
      lines: [{
        text: "文",
        bbox: textBox,
        quad: [
          { x: textBox.x, y: textBox.y },
          { x: textBox.x + textBox.width, y: textBox.y },
          { x: textBox.x + textBox.width, y: textBox.y + textBox.height },
          { x: textBox.x, y: textBox.y + textBox.height },
        ],
      }],
    };
    const packageScene: SceneGraph = {
      graphVersion: 1,
      canvas: { width, height },
      nodes: [
        {
          id: "background",
          role: "background",
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          confidence: 1,
          zIndex: 0,
          label: "complete canvas",
          extractionHints: [],
        },
        {
          id: "rear-object",
          role: "foreground-object",
          bbox: {
            x: rear.x / width,
            y: rear.y / height,
            width: rear.width / width,
            height: rear.height / height,
          },
          confidence: 0.99,
          zIndex: 1,
          label: "audit-only rear label",
          extractionHints: [],
        },
        {
          id: "front-object",
          role: "foreground-object",
          bbox: {
            x: front.x / width,
            y: front.y / height,
            width: front.width / width,
            height: front.height / height,
          },
          confidence: 0.99,
          zIndex: 2,
          label: "audit-only front label",
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
    };
    const refinementPath = "refinements/refinement-001.json";
    const refinementBytes = Buffer.from(
      `${JSON.stringify({ request: "regional", accepted: true }, null, 2)}\n`,
    );
    const completionPath = "completions/completion-001.png";
    const sourceCropPath = "completions/completion-001-source-crop.png";
    const visibleMaskPath = "completions/completion-001-visible-mask.png";
    const generatedMaskPath = "completions/completion-001-generated-mask.png";
    const semanticPlan = planSemanticLayers(packageScene, packageOcr);
    const rearCandidate = semanticPlan.candidates.find(
      ({ id }) => id === "rear-object",
    );
    assert.ok(rearCandidate?.occlusion);
    const emptyTextMask = await sharp(Buffer.alloc(width * height), {
      raw: { width, height, channels: 1 },
    }).png().toBuffer();
    const selected = chooseSemanticMask(
      await deriveSemanticMasks(canvas, rearCandidate),
      emptyTextMask,
    );
    assert.ok(selected);
    assert.ok(
      [selected.bbox.x, selected.bbox.y, selected.bbox.width, selected.bbox.height]
        .every(Number.isInteger),
    );
    const crop = selected.bbox;
    const cropWidth = Math.ceil(crop.width);
    const cropHeight = Math.ceil(crop.height);
    const completionRgba = Buffer.alloc(cropWidth * cropHeight * 4);
    const visibleMask = Buffer.alloc(cropWidth * cropHeight);
    const generatedMask = Buffer.alloc(cropWidth * cropHeight);
    for (let y = 0; y < cropHeight; y += 1) {
      for (let x = 0; x < cropWidth; x += 1) {
        const canvasX = crop.x + x;
        const canvasY = crop.y + y;
        const insideRear =
          canvasX >= rear.x &&
          canvasX < rear.x + rear.width &&
          canvasY >= rear.y &&
          canvasY < rear.y + rear.height;
        if (!insideRear) continue;
        const insideFront =
          canvasX >= front.x &&
          canvasX < front.x + front.width &&
          canvasY >= front.y &&
          canvasY < front.y + front.height;
        const index = y * cropWidth + x;
        completionRgba.set([43, 109, 168, 255], index * 4);
        if (insideFront) generatedMask[index] = 255;
        else visibleMask[index] = 255;
      }
    }
    const sourceCropBytes = await sharp(rgba, {
      raw: { width, height, channels: 4 },
    })
      .extract({
        left: crop.x,
        top: crop.y,
        width: cropWidth,
        height: cropHeight,
      })
      .png()
      .toBuffer();
    const [completionBytes, visibleMaskBytes, generatedMaskBytes] =
      await Promise.all([
        sharp(completionRgba, {
          raw: { width: cropWidth, height: cropHeight, channels: 4 },
        }).png().toBuffer(),
        sharp(visibleMask, {
          raw: { width: cropWidth, height: cropHeight, channels: 1 },
        }).png().toBuffer(),
        sharp(generatedMask, {
          raw: { width: cropWidth, height: cropHeight, channels: 1 },
        }).png().toBuffer(),
      ]);
    await Promise.all([
      mkdir(join(analysisDir, "refinements")),
      mkdir(join(analysisDir, "completions")),
    ]);
    await Promise.all([
      writeFile(join(analysisDir, refinementPath), refinementBytes, { mode: 0o600 }),
      writeFile(join(analysisDir, completionPath), completionBytes, { mode: 0o600 }),
      writeFile(join(analysisDir, sourceCropPath), sourceCropBytes, { mode: 0o600 }),
      writeFile(join(analysisDir, visibleMaskPath), visibleMaskBytes, { mode: 0o600 }),
      writeFile(join(analysisDir, generatedMaskPath), generatedMaskBytes, { mode: 0o600 }),
      writeFile(join(analysisDir, "unreferenced-provider-response.json"), "do-not-copy", { mode: 0o600 }),
    ]);
    const refinements = [{
      path: refinementPath,
      sha256: sha256(refinementBytes),
      crop: { x: 128, y: 8, width: 72, height: 64 },
    }];
    const completions = [{
      path: completionPath,
      sha256: sha256(completionBytes),
      crop,
      candidateId: "rear-object",
      sourceCropPath,
      visibleMaskPath,
      generatedMaskPath,
      reviewRequired: true as const,
      provenance: {
        kind: "composite" as const,
        sourceCropSha256: sha256(sourceCropBytes),
        visibleMaskSha256: sha256(visibleMaskBytes),
        generatedMaskSha256: sha256(generatedMaskBytes),
        assetSha256: sha256(completionBytes),
        modelId: "wanx2.1-imageedit",
        taskIdSha256: sha256("raw-provider-task-never-persisted"),
        sanitizedProviderMetadata: { status: "SUCCEEDED", attempts: 1 },
      },
    }];
    const analysisLedger: AnalysisPackageV2 = {
      analysisVersion: 2,
      mode: "replay",
      recorded: true,
      canvas: packageScene.canvas,
      source: {
        path: "source.rgba",
        sha256: sha256(rgba),
        originalSha256: sha256(sourceBytes),
        format: "png",
      },
      ocr: {
        path: "ocr.json",
        sha256: sha256(`${JSON.stringify(packageOcr, null, 2)}\n`),
      },
      scene: {
        path: "scene-graph.json",
        sha256: sha256(`${JSON.stringify(packageScene, null, 2)}\n`),
      },
      refinements,
      completions,
      requests: { ocr: 1, fullVision: 1, regionalVision: 1, completion: 1 },
      models: {
        ocr: "qwen3.5-ocr",
        fullVision: "qwen3-vl-plus",
        regionalVision: "qwen3-vl-plus",
        completion: "wanx2.1-imageedit",
      },
      durationsMs: {
        ocr: 1,
        fullVision: 1,
        regionalVision: 1,
        completion: 1,
        analyze: 4,
      },
      warnings: [],
    };
    await writeAnalysisPackageV2({
      directory: analysisDir,
      canvas,
      ocr: packageOcr,
      scene: packageScene,
      refinements,
      completions,
      ledger: analysisLedger,
    });

    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("offline build attempted network access");
    };

    const result = await buildSlide({
      analysisDir,
      outDir,
    });

    assert.equal(fetchCalls, 0);
    await Promise.all([
      access(result.pptxPath),
      access(join(outDir, "scene-graph.json")),
      access(join(outDir, "analysis-ledger.json")),
    ]);
    const copiedAnalysisLedger = await readAnalysisPackage(outDir);
    assert.equal(copiedAnalysisLedger.analysisVersion, 2);
    assert.deepEqual(copiedAnalysisLedger.requests, analysisLedger.requests);
    assert.equal(
      copiedAnalysisLedger.source.originalSha256,
      analysisLedger.source.originalSha256,
    );
    assert.equal(copiedAnalysisLedger.refinements.length, 1);
    assert.equal(copiedAnalysisLedger.completions.length, 1);
    const copiedCompletion = copiedAnalysisLedger.completions[0]!;
    assert.equal(copiedCompletion.provenance.kind, "composite");
    const manifest = JSON.parse(
      await readFile(result.manifestPath, "utf8"),
    ) as {
      manifestVersion: number;
      elements: Array<{
        kind: string;
        id: string;
        assetPath?: string;
        reviewRequired?: boolean;
        provenance?: { kind: string };
      }>;
    };
    assert.equal(manifest.manifestVersion, 2);
    const generatedLayer = manifest.elements.find(
      ({ id }) => id === "rear-object",
    );
    assert.deepEqual(
      {
        kind: generatedLayer?.kind,
        reviewRequired: generatedLayer?.reviewRequired,
        provenance: generatedLayer?.provenance?.kind,
      },
      {
        kind: "asset",
        reviewRequired: true,
        provenance: "composite",
      },
    );
    assert.match(
      generatedLayer?.assetPath ?? "",
      /^assets\/semantic-\d{3}-[a-f0-9]{10}\.png$/,
    );
    await access(join(outDir, generatedLayer!.assetPath!));
    const publication = await readSemanticAssetPublication(join(outDir, "assets"));
    assert.ok(
      publication.inventory.some(
        ({ path }) => path === generatedLayer?.assetPath,
      ),
    );

    const qaNames = [
      "recomposition-preview.png",
      "layer-review.png",
      "exploded-preview.png",
    ];
    await Promise.all(qaNames.map((name) => access(join(outDir, name))));
    const [cleanBackground, recompositionPreview] = await Promise.all([
      sharp(join(outDir, "clean-background.png"))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(join(outDir, "recomposition-preview.png"))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
    const glyphPixel = (image: typeof cleanBackground): number[] => {
      const offset = (130 * image.info.width + 60) * image.info.channels;
      return [...image.data.subarray(offset, offset + 4)];
    };
    assert.deepEqual(
      {
        cleanBackground: glyphPixel(cleanBackground),
        sourceFaithfulQa: glyphPixel(recompositionPreview),
      },
      {
        cleanBackground: [247, 243, 233, 255],
        sourceFaithfulQa: [35, 57, 77, 255],
      },
      "offline QA must recover the verified RGBA stroke beyond the generic placeholder box",
    );
    const runLedger = JSON.parse(
      await readFile(result.ledgerPath, "utf8"),
    ) as {
      hashes: {
        qaPreviews: Record<string, string>;
      };
      outputs: {
        qaPreviews: Record<string, string>;
      };
    };
    assert.deepEqual(Object.keys(runLedger.hashes.qaPreviews).sort(), [
      "exploded",
      "layerReview",
      "recomposition",
    ]);
    assert.deepEqual(
      Object.values(runLedger.outputs.qaPreviews).map((path) => basename(path)).sort(),
      [...qaNames].sort(),
    );
    assert.equal(
      runLedger.hashes.qaPreviews.recomposition,
      sha256(await readFile(join(outDir, "recomposition-preview.png"))),
    );
    const pptx = await JSZip.loadAsync(await readFile(result.pptxPath));
    const slideXml = await pptx.file("ppt/slides/slide1.xml")!.async("string");
    assert.match(slideXml, /name="asset-rear-object"/);
    const referencedArtifacts = [
      copiedAnalysisLedger.source,
      copiedAnalysisLedger.ocr,
      copiedAnalysisLedger.scene,
      ...copiedAnalysisLedger.refinements,
      copiedCompletion,
      {
        path: copiedCompletion.sourceCropPath,
        sha256: copiedCompletion.provenance.sourceCropSha256,
      },
      {
        path: copiedCompletion.visibleMaskPath,
        sha256: copiedCompletion.provenance.visibleMaskSha256,
      },
      {
        path: copiedCompletion.generatedMaskPath,
        sha256: copiedCompletion.provenance.generatedMaskSha256,
      },
    ];
    for (const artifact of referencedArtifacts) {
      const copiedPath = join(outDir, artifact.path);
      assert.equal(sha256(await readFile(copiedPath)), artifact.sha256);
      assert.equal((await stat(copiedPath)).mode & 0o777, 0o600);
    }
    await assert.rejects(
      access(join(outDir, "unreferenced-provider-response.json")),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires standalone analyze output to be new or empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-analyze-contract-"));
  const imagePath = join(directory, "slide-07.png");
  const analysisDir = join(directory, "analysis");
  const sentinelPath = join(analysisDir, "user-file.txt");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    await mkdir(analysisDir);
    await writeFile(sentinelPath, "must remain untouched\n");

    await assert.rejects(
      analyzeSlide({
        imagePath,
        outDir: analysisDir,
        replay: {
          ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
          visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
        },
      }),
      /analysis output directory must be new or empty/i,
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "must remain untouched\n");
    assert.deepEqual(await readdir(analysisDir), ["user-file.txt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed standalone build preserves its owned success and retains staged evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-build-transaction-"));
  const imagePath = join(directory, "slide-07.png");
  const firstAnalysisDir = join(directory, "analysis-first");
  const secondAnalysisDir = join(directory, "analysis-second");
  const outDir = join(directory, "output");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    await analyzeSlide({
      imagePath,
      outDir: firstAnalysisDir,
      replay: {
        ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
        visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
      },
    });
    await buildSlide({
      imagePath,
      analysisDir: firstAnalysisDir,
      outDir,
      fidelityBuild: deterministicFidelityBuild,
    });
    const before = await snapshotTree(outDir);
    const smallerReplay = await writeNormalizedReplay(
      directory,
      { lines: [] },
      { elements: [] },
    );
    await analyzeSlide({
      imagePath,
      outDir: secondAnalysisDir,
      replay: smallerReplay,
    });

    await assert.rejects(
      buildSlide({
        imagePath,
        analysisDir: secondAnalysisDir,
        outDir,
        fidelityBuild: failingFidelityBuild("simulated split build failure"),
      }),
      /simulated split build failure/,
    );

    assert.deepEqual(await snapshotTree(outDir), before);
    const failedRuns = await readdir(`${outDir}.failed-runs`);
    assert.equal(failedRuns.length, 1);
    const failedRun = join(`${outDir}.failed-runs`, failedRuns[0]!);
    await Promise.all([
      access(join(failedRun, "analysis-ledger.json")),
      access(join(failedRun, "ocr.json")),
      access(join(failedRun, "vision.json")),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful smaller standalone build removes stale assets and recordings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-build-stale-"));
  const imagePath = join(directory, "slide-07.png");
  const firstAnalysisDir = join(directory, "analysis-first");
  const secondAnalysisDir = join(directory, "analysis-second");
  const outDir = join(directory, "output");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    await analyzeSlide({
      imagePath,
      outDir: firstAnalysisDir,
      replay: {
        ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
        visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
      },
      record: true,
    });
    await buildSlide({
      imagePath,
      analysisDir: firstAnalysisDir,
      outDir,
      fidelityBuild: deterministicFidelityBuild,
    });
    assert.ok((await readdir(join(outDir, "assets"))).length > 0);
    await access(join(outDir, "recordings/ocr.json"));

    const smallerReplay = await writeNormalizedReplay(
      directory,
      { lines: [] },
      { elements: [] },
    );
    await analyzeSlide({
      imagePath,
      outDir: secondAnalysisDir,
      replay: smallerReplay,
      record: false,
    });
    await buildSlide({
      imagePath,
      analysisDir: secondAnalysisDir,
      outDir,
      fidelityBuild: deterministicFidelityBuild,
    });

    assert.deepEqual(await readdir(join(outDir, "assets")), []);
    await assert.rejects(access(join(outDir, "recordings")), /ENOENT/);
    const ledger = JSON.parse(
      await readFile(join(outDir, "run-ledger.json"), "utf8"),
    ) as { taskIds: { wanx?: string } };
    assert.equal(ledger.taskIds.wanx, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("record mode writes sanitized replay snapshots and explicit metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-record-"));
  const imagePath = join(directory, "slide-07.png");
  const outDir = join(directory, "analysis");
  const ocrFixturePath = join(directory, "raw-ocr.json");
  const visionFixturePath = join(directory, "raw-vision.json");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    const rawOcr = JSON.parse(
      await readFile(
        resolve("tests/fixtures/qwen-ocr-slide-07.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const rawVision = JSON.parse(
      await readFile(
        resolve("tests/fixtures/qwen-vision-slide-07.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    rawOcr.Authorization = "Bearer replay-credential-canary";
    rawVision.apiKey = "replay-credential-canary";
    await Promise.all([
      writeFile(ocrFixturePath, JSON.stringify(rawOcr), "utf8"),
      writeFile(visionFixturePath, JSON.stringify(rawVision), "utf8"),
    ]);

    await analyzeSlide({
      imagePath,
      outDir,
      replay: { ocrPath: ocrFixturePath, visionPath: visionFixturePath },
      record: true,
    });

    const ocrRecording = await readFile(
      join(outDir, "recordings/ocr.json"),
      "utf8",
    );
    const visionRecording = await readFile(
      join(outDir, "recordings/vision.json"),
      "utf8",
    );
    assert.equal(
      ocrRecording,
      await readFile(join(outDir, "ocr.json"), "utf8"),
    );
    assert.equal(
      visionRecording,
      await readFile(join(outDir, "vision.json"), "utf8"),
    );
    const analysisLedgerText = await readFile(
      join(outDir, "analysis-ledger.json"),
      "utf8",
    );
    const analysisLedger = JSON.parse(analysisLedgerText) as {
      recorded: boolean;
      recordings?: Record<string, string>;
    };
    assert.equal(analysisLedger.recorded, true);
    assert.deepEqual(analysisLedger.recordings, {
      ocr: "recordings/ocr.json",
      vision: "recordings/vision.json",
    });
    assert.doesNotMatch(
      ocrRecording + visionRecording + analysisLedgerText,
      /replay-credential-canary|authorization|apiKey|bearer/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains sanitized malformed live OCR response and parse error in the failed run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-malformed-ocr-"));
  const imagePath = join(directory, "slide-07.png");
  const outDir = join(directory, "output");
  const originalFetch = globalThis.fetch;

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    const visionFixture = JSON.parse(
      await readFile(resolve("tests/fixtures/qwen-vision-slide-07.json"), "utf8"),
    ) as { choices: Array<{ message: { content: string } }> };

    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/chat/completions")) {
        return Response.json({
          id: "valid-vision",
          object: "chat.completion",
          created: 0,
          model: liveConfig.visionModel,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: visionFixture.choices[0]!.message.content,
              },
            },
          ],
        });
      }
      return Response.json({
        Authorization: "Bearer provider-secret-canary",
        "x-dashscope-api-key": "provider-secret-canary",
        output: {
          choices: [
            {
              message: {
                content: [{ text: "plain response without coordinates" }],
              },
            },
          ],
        },
      });
    };

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        config: liveConfig,
      }),
      /coordinates require the advanced_recognition task/i,
    );

    const failedRuns = await readdir(`${outDir}.failed-runs`);
    assert.equal(failedRuns.length, 1);
    const failedRun = join(`${outDir}.failed-runs`, failedRuns[0]!);
    const raw = await readFile(join(failedRun, "raw-responses/ocr.json"), "utf8");
    const parseError = await readFile(
      join(failedRun, "parse-errors/ocr.json"),
      "utf8",
    );
    assert.match(raw, /plain response without coordinates/);
    assert.match(parseError, /advanced_recognition/);
    assert.doesNotMatch(
      raw + parseError,
      /provider-secret-canary|authorization|api[_-]?key|bearer/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("retains sanitized malformed live Vision response and parse error in the failed run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-malformed-vision-"));
  const imagePath = join(directory, "slide-07.png");
  const outDir = join(directory, "output");
  const originalFetch = globalThis.fetch;

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    const validOcr = JSON.parse(
      await readFile(resolve("tests/fixtures/qwen-ocr-slide-07.json"), "utf8"),
    ) as unknown;

    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/chat/completions")) {
        return Response.json({
          id: "malformed-vision",
          object: "chat.completion",
          created: 0,
          model: liveConfig.visionModel,
          apiKey: "provider-secret-canary",
          Authorization: "Bearer provider-secret-canary",
          detail: "provider-secret-canary",
          diagnostics: [
            "Bearer nested-bearer-canary-123456789",
            "sk-nested-credential-canary-123456789",
            "https://bucket.oss-cn-beijing.aliyuncs.com/file.png?X-OSS-Signature=nested-signature-canary&Expires=999999#nested-fragment-canary",
          ],
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "not valid JSON from Vision",
              },
            },
          ],
        });
      }
      return Response.json(validOcr);
    };

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        config: liveConfig,
      }),
      /(?:qwen scene|vision) response is not valid JSON/i,
    );

    const failedRuns = await readdir(`${outDir}.failed-runs`);
    assert.equal(failedRuns.length, 1);
    const failedRun = join(`${outDir}.failed-runs`, failedRuns[0]!);
    const raw = await readFile(
      join(failedRun, "raw-responses/vision.json"),
      "utf8",
    );
    const parseError = await readFile(
      join(failedRun, "parse-errors/vision.json"),
      "utf8",
    );
    assert.match(raw, /not valid JSON from Vision/);
    assert.match(parseError, /not valid JSON/);
    assert.doesNotMatch(
      raw + parseError,
      /provider-secret-canary|nested-bearer-canary|nested-credential-canary|nested-signature-canary|nested-fragment-canary|X-OSS-Signature|Expires=999999|authorization|api[_-]?key|bearer/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("captures a bounded sanitized invalid-JSON OCR HTTP body before decoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-invalid-json-ocr-"));
  const imagePath = join(directory, "slide-07.png");
  const outDir = join(directory, "output");
  const originalFetch = globalThis.fetch;

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    const visionFixture = JSON.parse(
      await readFile(resolve("tests/fixtures/qwen-vision-slide-07.json"), "utf8"),
    ) as { choices: Array<{ message: { content: string } }> };

    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/chat/completions")) {
        return Response.json({
          id: "valid-vision",
          object: "chat.completion",
          created: 0,
          model: liveConfig.visionModel,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: visionFixture.choices[0]!.message.content,
              },
            },
          ],
        });
      }
      return new Response(oversizedInvalidJsonBody("ocr"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        config: liveConfig,
      }),
      /OCR HTTP response is not valid JSON/i,
    );

    const failedRuns = await readdir(`${outDir}.failed-runs`);
    const failedRun = join(`${outDir}.failed-runs`, failedRuns[0]!);
    const rawText = await readFile(
      join(failedRun, "raw-responses/ocr.json"),
      "utf8",
    );
    const raw = JSON.parse(rawText) as {
      body: string;
      originalLength: number;
      truncated: boolean;
    };
    const parseError = await readFile(
      join(failedRun, "parse-errors/ocr.json"),
      "utf8",
    );
    assert.equal(failedRuns.length, 1);
    assert.equal(raw.truncated, true);
    assert.ok(raw.originalLength > 65_536);
    assert.ok(raw.body.length <= 65_536);
    assert.match(raw.body, /not-json-ocr/);
    assert.match(parseError, /OCR HTTP response is not valid JSON/);
    assert.doesNotMatch(
      rawText + parseError,
      /provider-secret-canary|sk-round2-credential|LTAI0123456789ABCDEF|quoted-round2|authorization|api[_-]?key|bearer/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("captures a bounded sanitized invalid-JSON Vision HTTP body before decoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-invalid-json-vision-"));
  const imagePath = join(directory, "slide-07.png");
  const outDir = join(directory, "output");
  const originalFetch = globalThis.fetch;

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    const validOcr = JSON.parse(
      await readFile(resolve("tests/fixtures/qwen-ocr-slide-07.json"), "utf8"),
    ) as unknown;

    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/chat/completions")) {
        return new Response(oversizedInvalidJsonBody("vision"), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return Response.json(validOcr);
    };

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        config: liveConfig,
      }),
      /(?:Qwen scene|Vision) HTTP response is not valid JSON/i,
    );

    const failedRuns = await readdir(`${outDir}.failed-runs`);
    const failedRun = join(`${outDir}.failed-runs`, failedRuns[0]!);
    const rawText = await readFile(
      join(failedRun, "raw-responses/vision.json"),
      "utf8",
    );
    const raw = JSON.parse(rawText) as {
      body: string;
      originalLength: number;
      truncated: boolean;
    };
    const parseError = await readFile(
      join(failedRun, "parse-errors/vision.json"),
      "utf8",
    );
    assert.equal(failedRuns.length, 1);
    assert.equal(raw.truncated, true);
    assert.ok(raw.originalLength > 65_536);
    assert.ok(raw.body.length <= 65_536);
    assert.match(raw.body, /not-json-vision/);
    assert.match(
      parseError,
      /(?:Qwen scene|Vision) HTTP response is not valid JSON/,
    );
    assert.doesNotMatch(
      rawText + parseError,
      /provider-secret-canary|sk-round2-credential|LTAI0123456789ABCDEF|quoted-round2|authorization|api[_-]?key|bearer/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed rerun preserves the previous successful target without mixed artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-transaction-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    await mkdir(join(outDir, "assets"), { recursive: true });
    await Promise.all([
      writeFile(join(outDir, "previous-success.txt"), "stable-success\n"),
      writeFile(join(outDir, "slide-07-editable.pptx"), "old-pptx"),
      writeFile(join(outDir, "run-ledger.json"), '{"old":true}\n'),
      writeFile(join(outDir, "assets/old.png"), "old-asset"),
      writeFile(
        join(outDir, ".image-ppt-layers-output.json"),
        `${JSON.stringify({
          markerVersion: 1,
          appId: "image-ppt-layers",
          artifactKind: "published-output",
        })}\n`,
      ),
    ]);
    const before = await snapshotTree(outDir);

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay: {
          ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
          visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
        },
        record: true,
        fidelityBuild: failingFidelityBuild("simulated fidelity rerun failure"),
      }),
      /simulated fidelity rerun failure/,
    );

    assert.deepEqual(await snapshotTree(outDir), before);
    const failedRoot = `${outDir}.failed-runs`;
    const failedRuns = await readdir(failedRoot);
    assert.equal(failedRuns.length, 1);
    const failedRun = join(failedRoot, failedRuns[0]!);
    await Promise.all([
      access(join(failedRun, "analysis-ledger.json")),
      access(join(failedRun, "ocr.json")),
      access(join(failedRun, "vision.json")),
    ]);
    await assert.rejects(
      access(join(failedRun, "slide-07-editable.pptx")),
      /ENOENT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not follow a failed-run symlink introduced after publication preflight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-failed-root-race-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");
  const external = join(directory, "external-failed-runs");

  try {
    await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    }).png().toFile(imagePath);
    await mkdir(external);

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay: {
          ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
          visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
        },
        fidelityBuild: async () => {
          await symlink(external, `${outDir}.failed-runs`);
          throw new Error("simulated post-preflight failure");
        },
      }),
      /simulated post-preflight failure/,
    );

    assert.deepEqual(await readdir(external), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not mask the primary build error when failed-run retention is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-failed-retention-error-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    }).png().toFile(imagePath);

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay: {
          ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
          visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
        },
        fidelityBuild: async () => {
          await chmod(directory, 0o500);
          throw new Error("primary build failure");
        },
      }),
      /primary build failure/,
    );
  } finally {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

test("required text count rejects a nine-text rerun before publication and retains evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-required-text-count-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    }).png().toBuffer();
    await sharp(source).toFile(imagePath);
    const replay = {
      ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
      visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
    };
    await runPipeline({
      imagePath,
      outDir,
      replay,
      requiredTextCount: 10,
      fidelityBuild: deterministicFidelityBuild,
    });
    const before = await snapshotTree(outDir);
    const normalizedOcr = JSON.parse(
      await readFile(join(outDir, "ocr.json"), "utf8"),
    ) as { lines: unknown[] };
    const normalizedVision = JSON.parse(
      await readFile(join(outDir, "vision.json"), "utf8"),
    );
    const nineTextReplay = await writeNormalizedReplay(
      directory,
      { ...normalizedOcr, lines: normalizedOcr.lines.slice(0, 9) },
      normalizedVision,
    );
    let fidelityBuildCalled = false;

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay: nineTextReplay,
        requiredTextCount: 10,
        fidelityBuild: async (...args) => {
          fidelityBuildCalled = true;
          return deterministicFidelityBuild(...args);
        },
      }),
      /required text count mismatch.*planned 9.*required 10/i,
    );

    assert.equal(fidelityBuildCalled, false);
    assert.deepEqual(await snapshotTree(outDir), before);
    const failedRuns = await readdir(`${outDir}.failed-runs`);
    assert.equal(failedRuns.length, 1);
    const failedRun = join(`${outDir}.failed-runs`, failedRuns[0]!);
    await Promise.all([
      access(join(failedRun, "analysis-ledger.json")),
      access(join(failedRun, "ocr.json")),
      access(join(failedRun, "vision.json")),
    ]);
    await assert.rejects(access(join(failedRun, "manifest.json")), /ENOENT/);
    await assert.rejects(
      access(join(failedRun, "slide-07-editable.pptx")),
      /ENOENT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("required text count validates accepted manifest texts before export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-accepted-text-count-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    }).png().toFile(imagePath);
    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay: {
          ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
          visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
        },
        requiredTextCount: 10,
        fidelityBuild: async (...args) => {
          const result = await deterministicFidelityBuild(...args);
          const firstTextId = result.manifest.elements.find(
            (element) => element.kind === "text",
          )?.id;
          result.manifest.elements = result.manifest.elements.filter(
            (element) => element.kind !== "text" || element.id !== firstTextId,
          );
          return result;
        },
      }),
      /required text count mismatch.*accepted 9.*required 10/i,
    );
    const failedRuns = await readdir(`${outDir}.failed-runs`);
    assert.equal(failedRuns.length, 1);
    const failedRun = join(`${outDir}.failed-runs`, failedRuns[0]!);
    await assert.rejects(
      access(join(failedRun, "slide-07-editable.pptx")),
      /ENOENT/,
    );
    await assert.rejects(
      access(join(failedRun, OUTPUT_OWNERSHIP_MARKER)),
      /ENOENT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an untracked fidelity asset before publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-untracked-asset-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    }).png().toFile(imagePath);

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay: {
          ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
          visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
        },
        fidelityBuild: async (...args) => {
          const result = await deterministicFidelityBuild(...args);
          result.assets.set("assets/orphan.png", args[0]);
          return result;
        },
      }),
      /untracked fidelity asset: assets\/orphan\.png/i,
    );
    await assert.rejects(access(outDir), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a fidelity decision ledger that does not cover the manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-incomplete-decisions-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    }).png().toFile(imagePath);

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay: {
          ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
          visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
        },
        fidelityBuild: async (...args) => {
          const result = await deterministicFidelityBuild(...args);
          result.decisions = result.decisions.slice(1);
          return result;
        },
      }),
      /missing fidelity decision for candidate: ocr-1/i,
    );
    await assert.rejects(access(outDir), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to replace an unowned output directory and leaves it unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-unowned-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    await mkdir(join(outDir, "user-files"), { recursive: true });
    await Promise.all([
      writeFile(join(outDir, "sentinel.txt"), "must-survive\n"),
      writeFile(join(outDir, "user-files/data.bin"), "user-data"),
    ]);
    const before = await snapshotTree(outDir);

    await assert.rejects(
      runPipeline({
        imagePath,
        outDir,
        replay: {
          ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
          visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
        },
        fidelityBuild: deterministicFidelityBuild,
      }),
      /Refusing to replace unowned output directory/,
    );

    assert.deepEqual(await snapshotTree(outDir), before);
    await assert.rejects(access(`${outDir}.failed-runs`), /ENOENT/);
    assert.ok(
      (await readdir(directory)).every(
        (name) => !name.includes(".staging-") && !name.includes(".previous-"),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomically replaces an output created and marked by this pipeline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-pipeline-owned-"));
  const imagePath = join(directory, "source-slide-07.png");
  const outDir = join(directory, "slide-07");

  try {
    const source = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: "#f7f3e9",
      },
    })
      .png()
      .toBuffer();
    await sharp(source).toFile(imagePath);
    const replay = {
      ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
      visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
    };

    await runPipeline({
      imagePath,
      outDir,
      replay,
      fidelityBuild: deterministicFidelityBuild,
    });
    assert.equal(
      OUTPUT_OWNERSHIP_MARKER,
      ".image-to-editable-pptx-output.json",
    );
    const markerPath = join(outDir, OUTPUT_OWNERSHIP_MARKER);
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
      markerVersion: 1,
      appId: "image-to-editable-pptx",
      artifactKind: "published-output",
    });

    await runPipeline({
      imagePath,
      outDir,
      replay,
      fidelityBuild: deterministicFidelityBuild,
    });

    const ledger = JSON.parse(
      await readFile(join(outDir, "run-ledger.json"), "utf8"),
    ) as { taskIds: { wanx?: string } };
    assert.equal(ledger.taskIds.wanx, undefined);
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
      markerVersion: 1,
      appId: "image-to-editable-pptx",
      artifactKind: "published-output",
    });
    const siblings = await readdir(directory);
    assert.ok(
      siblings.every((name) => !name.includes(".previous-") && !name.includes(".staging-")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
