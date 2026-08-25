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

import {
  analyzeSlide,
  buildSlide,
  runPipeline,
} from "../src/pipeline.js";

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
    ) as { elements: Array<{ kind: string }> };
    const assets = manifest.elements.filter(
      (element) => element.kind === "asset",
    );
    assert.ok(assets.length >= 6);

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
      join(outDir, "slide-07-editable.pptx"),
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
