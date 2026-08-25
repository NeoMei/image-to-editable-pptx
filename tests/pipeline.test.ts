import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import type { AppConfig } from "../src/config.js";
import {
  analyzeSlide,
  buildSlide,
  runPipeline,
} from "../src/pipeline.js";

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

    const result = await runPipeline({
      imagePath,
      outDir,
      replay: {
        ocrPath: resolve("tests/fixtures/qwen-ocr-slide-07.json"),
        visionPath: resolve("tests/fixtures/qwen-vision-slide-07.json"),
      },
      inpaint: async () => ({
        image: source,
        taskId: "wanx-replay-task-07",
      }),
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
    ) as { elements: Array<{ kind: string; label?: string }> };
    const assets = manifest.elements.filter(
      (element) => element.kind === "asset",
    );
    const nativeShapeLabels = manifest.elements
      .filter((element) => element.kind === "shape")
      .map((element) => element.label)
      .sort();
    const expectedNativeShapeLabels = [
      "MCP ecosystem panel",
      "bottom navy bar",
      "collaboration tools panel",
      "execution tools panel",
      "orange subtitle bar",
      "perception tools panel",
      "top section label",
    ].sort();
    assert.equal(assets.length, 6);
    assert.deepEqual(nativeShapeLabels, expectedNativeShapeLabels);
    assert.ok(
      assets.every(
        (element) => !expectedNativeShapeLabels.includes(element.label ?? ""),
      ),
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
      fallbacks: unknown[];
      hashes: Record<string, unknown>;
      outputs: Record<string, string>;
    };
    assert.equal(ledger.mode, "replay");
    assert.deepEqual(ledger.models, {
      ocr: "qwen3.5-ocr",
      vision: "qwen3-vl-plus",
      edit: "wanx2.1-imageedit",
    });
    assert.ok(
      Object.values(ledger.durationsMs).every(
        (duration) => Number.isFinite(duration) && duration >= 0,
      ),
    );
    assert.equal(ledger.taskIds.wanx, "wanx-replay-task-07");
    assert.ok(Array.isArray(ledger.warnings));
    assert.ok(Array.isArray(ledger.fallbacks));
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
    assert.match(slideXml, /name="asset-vision-/);
    for (const label of expectedNativeShapeLabels) {
      assert.match(
        slideXml,
        new RegExp(`name="shape-vision-\\d+-${label}"`),
      );
      assert.doesNotMatch(slideXml, new RegExp(`name="asset-[^"]*${label}"`));
    }
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
      inpaint: async () => ({
        image: source,
        taskId: "wanx-replay-split-07",
      }),
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
      edit: "live-edit-model",
    });
    assert.equal(ledger.durationsMs.ocr, 11);
    assert.equal(ledger.durationsMs.vision, 22);
    assert.equal(ledger.durationsMs.analyze, 33);
    assert.ok(ledger.warnings.includes("live-analysis-warning"));
  } finally {
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
      inpaint: async () => ({ image: source, taskId: "first-build" }),
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
        inpaint: async () => {
          throw new Error("simulated split build failure");
        },
      }),
      /simulated split build failure/,
    );

    assert.deepEqual(await snapshotTree(outDir), before);
    const failedRuns = await readdir(`${outDir}.failed-runs`);
    assert.equal(failedRuns.length, 1);
    const failedRun = join(`${outDir}.failed-runs`, failedRuns[0]!);
    await Promise.all([
      access(join(failedRun, "analysis-ledger.json")),
      access(join(failedRun, "manifest.json")),
      access(join(failedRun, "removal-mask.png")),
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
      inpaint: async () => ({ image: source, taskId: "large-build" }),
    });
    assert.equal((await readdir(join(outDir, "assets"))).length, 6);
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
      inpaint: async () => ({ image: source, taskId: "small-build" }),
    });

    assert.deepEqual(await readdir(join(outDir, "assets")), []);
    await assert.rejects(access(join(outDir, "recordings")), /ENOENT/);
    const ledger = JSON.parse(
      await readFile(join(outDir, "run-ledger.json"), "utf8"),
    ) as { taskIds: { wanx: string } };
    assert.equal(ledger.taskIds.wanx, "small-build");
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
        inpaint: async () => ({ image: source, taskId: "must-not-run" }),
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
        inpaint: async () => ({ image: source, taskId: "must-not-run" }),
      }),
      /vision response is not valid JSON/i,
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
      /provider-secret-canary|authorization|api[_-]?key|bearer/i,
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
        inpaint: async () => {
          throw new Error("simulated Wanx rerun failure");
        },
      }),
      /simulated Wanx rerun failure/,
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
      access(join(failedRun, "removal-mask.png")),
    ]);
    await assert.rejects(
      access(join(failedRun, "slide-07-editable.pptx")),
      /ENOENT/,
    );
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
        inpaint: async () => ({ image: source, taskId: "must-not-run" }),
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
      inpaint: async () => ({ image: source, taskId: "owned-first" }),
    });
    const markerPath = join(outDir, ".image-ppt-layers-output.json");
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
      markerVersion: 1,
      appId: "image-ppt-layers",
      artifactKind: "published-output",
    });

    await runPipeline({
      imagePath,
      outDir,
      replay,
      inpaint: async () => ({ image: source, taskId: "owned-second" }),
    });

    const ledger = JSON.parse(
      await readFile(join(outDir, "run-ledger.json"), "utf8"),
    ) as { taskIds: { wanx: string } };
    assert.equal(ledger.taskIds.wanx, "owned-second");
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
      markerVersion: 1,
      appId: "image-ppt-layers",
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
