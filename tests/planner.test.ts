import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  SlideManifestSchema,
  type OcrResult,
  type VisionResult,
} from "../src/contracts.js";
import { planSlide } from "../src/planner.js";
import { parseQwenOcrResponse } from "../src/providers/qwen-ocr.js";
import { parseQwenVisionContent } from "../src/providers/qwen-vision.js";

const emptyOcr: OcrResult = { lines: [] };

function ocrLine(
  text: string,
  bbox: { x: number; y: number; width: number; height: number },
): OcrResult["lines"][number] {
  return {
    text,
    bbox,
    quad: [
      { x: bbox.x, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
      { x: bbox.x, y: bbox.y + bbox.height },
    ],
  };
}

function visionElement(
  overrides: Partial<VisionResult["elements"][number]> = {},
): VisionResult["elements"][number] {
  return {
    type: "icon",
    bbox: { x: 20, y: 20, width: 40, height: 40 },
    label: "candidate",
    zIndex: 2,
    editableAs: "bitmap",
    confidence: 0.95,
    ...overrides,
  };
}

test("OCR text wins over an overlapping visual text candidate", () => {
  const ocr: OcrResult = {
    lines: [ocrLine("Authoritative title", { x: 100, y: 40, width: 400, height: 60 })],
  };
  const vision: VisionResult = {
    elements: [
      visionElement({
        type: "text",
        bbox: { x: 105, y: 42, width: 390, height: 56 },
        label: "Incorrect visual guess",
        zIndex: 9,
        editableAs: "text",
        fillColor: "A1B2C3",
      }),
    ],
  };

  const manifest = planSlide(ocr, vision);
  const text = manifest.elements.filter((element) => element.kind === "text");

  assert.equal(text.length, 1);
  assert.equal(text[0]?.text, "Authoritative title");
  assert.equal(text[0]?.color, "A1B2C3");
  assert.equal(text[0]?.fontSizePx, 43.2);
});

test("high-confidence visual rectangles become native shapes", () => {
  const vision: VisionResult = {
    elements: [
      visionElement({
        type: "panel",
        bbox: { x: 80, y: 100, width: 280, height: 320 },
        label: "rounded panel",
        editableAs: "native-shape",
        confidence: 0.85,
        fillColor: "F4EBDD",
        strokeColor: "23394D",
        cornerRadius: 18,
      }),
    ],
  };

  const manifest = planSlide(emptyOcr, vision);

  assert.equal(manifest.elements[0]?.kind, "shape");
  assert.deepEqual(manifest.elements[0], {
    kind: "shape",
    id: "vision-1",
    shape: "roundRect",
    bbox: { x: 80, y: 100, width: 280, height: 320 },
    fillColor: "F4EBDD",
    strokeColor: "23394D",
    strokeWidthPx: 1,
    cornerRadiusPx: 18,
    zIndex: 2,
  });
});

test("uncertain visual rectangles become rectangular bitmap assets", () => {
  const vision: VisionResult = {
    elements: [
      visionElement({
        type: "shape",
        label: "uncertain rectangle",
        editableAs: "native-shape",
        confidence: 0.84,
      }),
    ],
  };

  const manifest = planSlide(emptyOcr, vision);
  const asset = manifest.elements[0];

  assert.equal(asset?.kind, "asset");
  assert.equal(asset?.extraction, "rectangular");
});

test("clips out-of-bounds bboxes and emits a warning", () => {
  const vision = {
    elements: [
      visionElement({
        bbox: { x: 1260, y: 700, width: 80, height: 60 },
        label: "edge asset",
      }),
    ],
  } as VisionResult;

  const manifest = planSlide(emptyOcr, vision);

  assert.deepEqual(manifest.elements[0]?.bbox, {
    x: 1260,
    y: 700,
    width: 20,
    height: 20,
  });
  assert.deepEqual(manifest.warnings, ["out_of_bounds_clipped"]);
  assert.doesNotThrow(() => SlideManifestSchema.parse(manifest));
});

test("sorts by zIndex and preserves input order for ties", () => {
  const vision: VisionResult = {
    elements: [
      visionElement({ label: "first tie", zIndex: 3 }),
      visionElement({ label: "lowest", zIndex: 1 }),
      visionElement({ label: "second tie", zIndex: 3 }),
    ],
  };

  const manifest = planSlide(emptyOcr, vision);

  assert.deepEqual(
    manifest.elements.map((element) =>
      element.kind === "asset" ? element.label : element.id,
    ),
    ["lowest", "first tie", "second tie"],
  );
});

test("uses deterministic default text styling with clamped font sizes", () => {
  const ocr: OcrResult = {
    lines: [
      ocrLine("small", { x: 10, y: 10, width: 80, height: 10 }),
      ocrLine("large", { x: 10, y: 100, width: 300, height: 200 }),
    ],
  };

  const manifest = planSlide(ocr, { elements: [] });
  const text = manifest.elements.filter((element) => element.kind === "text");

  assert.deepEqual(
    text.map((element) => ({ color: element.color, size: element.fontSizePx })),
    [
      { color: "23394D", size: 14 },
      { color: "23394D", size: 88 },
    ],
  );
});

test("plans the slide 7 fixture into title text, panels, and movable assets", async () => {
  const rawOcr = JSON.parse(
    await readFile(resolve("tests/fixtures/qwen-ocr-slide-07.json"), "utf8"),
  ) as unknown;
  const rawVision = JSON.parse(
    await readFile(resolve("tests/fixtures/qwen-vision-slide-07.json"), "utf8"),
  ) as { choices: Array<{ message: { content: string } }> };
  const ocr = parseQwenOcrResponse(rawOcr);
  const vision = parseQwenVisionContent(
    rawVision.choices[0]!.message.content,
  );

  const first = planSlide(ocr, vision);
  const second = planSlide(ocr, vision);
  const titleText = first.elements.filter(
    (element) =>
      element.kind === "text" && element.text.includes("第 4 章 工具"),
  );
  const panels = first.elements.filter((element) => element.kind === "shape");
  const assets = first.elements.filter((element) => element.kind === "asset");

  assert.ok(titleText.length >= 1);
  assert.ok(panels.length >= 4);
  assert.ok(assets.length >= 6);
  assert.doesNotThrow(() => SlideManifestSchema.parse(first));
  assert.deepEqual(second, first);
});
