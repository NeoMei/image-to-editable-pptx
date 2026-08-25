import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  SlideManifestSchema,
  type OcrResult,
  type VisionResult,
} from "../src/contracts.js";
import { buildRemovalMask } from "../src/image/mask.js";
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
    label: "rounded panel",
    shape: "roundRect",
    bbox: { x: 80, y: 100, width: 280, height: 320 },
    fillColor: "F4EBDD",
    strokeColor: "23394D",
    strokeWidthPx: 1,
    cornerRadiusPx: 18,
    zIndex: 2,
  });
});

test("excludes full-canvas background candidates from assets and the removal mask", async () => {
  const vision: VisionResult = {
    elements: [
      visionElement({
        type: "background",
        bbox: { x: 0, y: 0, width: 1280, height: 720 },
        label: "full slide paper background",
        zIndex: 0,
        editableAs: "bitmap",
      }),
      visionElement({
        type: "photo",
        bbox: { x: 0, y: 0, width: 1280, height: 720 },
        label: "background by editability contract",
        zIndex: 0,
        editableAs: "background",
      }),
    ],
  };

  const manifest = planSlide(emptyOcr, vision);
  const mask = await buildRemovalMask(1280, 720, manifest.elements);
  const { data } = await sharp(mask).removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });

  assert.deepEqual(manifest.elements, []);
  assert.ok(data.every((channel) => channel === 0));
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

test("clips OCR parser overflow and emits a warning", () => {
  const ocr = parseQwenOcrResponse({
    output: {
      choices: [
        {
          message: {
            content: [
              {
                ocr_result: {
                  words_info: [
                    {
                      text: "edge text",
                      location: [1260, 700, 1320, 700, 1320, 760, 1260, 760],
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  });

  const manifest = planSlide(ocr, { elements: [] });

  assert.deepEqual(manifest.elements[0]?.bbox, {
    x: 1260,
    y: 700,
    width: 20,
    height: 20,
  });
  assert.deepEqual(manifest.warnings, ["out_of_bounds_clipped"]);
  assert.doesNotThrow(() => SlideManifestSchema.parse(manifest));
});

test("clips Vision parser overflow and drops fully non-intersecting boxes", () => {
  const vision = parseQwenVisionContent(
    JSON.stringify({
      elements: [
        {
          type: "panel",
          bbox: [984, 972, 1031, 1056],
          label: "edge panel",
          zIndex: 1,
          editableAs: "native-shape",
          confidence: 0.95,
        },
        {
          type: "icon",
          bbox: [1016, 139, 1047, 194],
          label: "outside icon",
          zIndex: 2,
          editableAs: "bitmap",
          confidence: 0.95,
        },
      ],
    }),
  );

  const manifest = planSlide(emptyOcr, vision);

  assert.equal(vision.elements.length, 2);
  assert.equal(manifest.elements.length, 1);
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

test("merges adjacent aligned OCR body lines with similar estimated font sizes", () => {
  const ocr: OcrResult = {
    lines: [
      ocrLine("First paragraph line", { x: 100, y: 200, width: 420, height: 24 }),
      ocrLine("Second paragraph line", { x: 104, y: 230, width: 390, height: 25 }),
    ],
  };

  const manifest = planSlide(ocr, { elements: [] });
  const text = manifest.elements.filter((element) => element.kind === "text");

  assert.equal(text.length, 1);
  assert.equal(text[0]?.text, "First paragraph line\nSecond paragraph line");
  assert.deepEqual(text[0]?.bbox, { x: 100, y: 200, width: 420, height: 55 });
  assert.equal(text[0]?.fontSizePx, 17.64);
});

test("keeps OCR lines separate when distance, alignment, or font size differs", () => {
  const cases: Array<{ ocr: OcrResult; fontSizes: number[] }> = [
    {
      ocr: {
        lines: [
          ocrLine("far first", { x: 100, y: 100, width: 300, height: 24 }),
          ocrLine("far second", { x: 102, y: 170, width: 300, height: 24 }),
        ],
      },
      fontSizes: [17.28, 17.28],
    },
    {
      ocr: {
        lines: [
          ocrLine("aligned first", { x: 100, y: 100, width: 300, height: 24 }),
          ocrLine("shifted second", { x: 150, y: 130, width: 300, height: 24 }),
        ],
      },
      fontSizes: [17.28, 17.28],
    },
    {
      ocr: {
        lines: [
          ocrLine("small first", { x: 100, y: 100, width: 300, height: 20 }),
          ocrLine("large second", { x: 102, y: 125, width: 300, height: 34 }),
        ],
      },
      fontSizes: [14.4, 24.48],
    },
  ];

  for (const { ocr, fontSizes } of cases) {
    const text = planSlide(ocr, { elements: [] }).elements.filter(
      (element) => element.kind === "text",
    );
    assert.equal(text.length, 2);
    assert.deepEqual(
      text.map((element) => element.fontSizePx),
      fontSizes,
    );
  }
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
  const nativeShapeLabels = panels.map((element) => element.label).sort();
  const expectedNativeShapeLabels = [
    "MCP ecosystem panel",
    "bottom navy bar",
    "collaboration tools panel",
    "event-driven async Agent panel",
    "execution tools panel",
    "orange subtitle bar",
    "perception tools panel",
    "top section label",
  ].sort();

  assert.ok(titleText.length >= 1);
  assert.deepEqual(nativeShapeLabels, expectedNativeShapeLabels);
  assert.deepEqual(
    Object.fromEntries(
      panels.map((element) => [element.label, element.bbox]),
    ),
    {
      "top section label": { x: 17, y: 14, width: 242, height: 59 },
      "orange subtitle bar": { x: 134, y: 162, width: 1024, height: 56 },
      "perception tools panel": { x: 60, y: 240, width: 273, height: 345 },
      "execution tools panel": { x: 352, y: 240, width: 261, height: 345 },
      "collaboration tools panel": { x: 628, y: 240, width: 273, height: 345 },
      "MCP ecosystem panel": { x: 923, y: 240, width: 299, height: 173 },
      "event-driven async Agent panel": {
        x: 923,
        y: 425,
        width: 299,
        height: 163,
      },
      "bottom navy bar": { x: 42, y: 607, width: 1198, height: 82 },
    },
  );
  assert.equal(assets.length, 6);
  assert.ok(
    assets.every(
      (element) => !expectedNativeShapeLabels.includes(element.label),
    ),
  );
  assert.doesNotThrow(() => SlideManifestSchema.parse(first));
  assert.deepEqual(second, first);
});
