import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("builds into a different output directory without losing analysis artifacts", async () => {
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
      access(result.ledgerPath),
      access(result.pptxPath),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
