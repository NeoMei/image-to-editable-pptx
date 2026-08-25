import assert from "node:assert/strict";
import test from "node:test";

import {
  OcrResultSchema,
  SlideManifestSchema,
  VisionResultSchema,
} from "../src/contracts.js";

const validManifest = {
  manifestVersion: 1,
  canvas: { width: 1280, height: 720 },
  elements: [
    {
      kind: "text",
      id: "title",
      text: "AI-Agent",
      bbox: { x: 40, y: 32, width: 300, height: 64 },
      rotation: 0,
      color: "23394D",
      fontSizePx: 46,
      align: "left",
      zIndex: 10,
    },
  ],
  warnings: [],
};

test("parses a version 1 slide manifest", () => {
  const parsed = SlideManifestSchema.parse(validManifest);

  assert.equal(parsed.manifestVersion, 1);
});

test("rejects a bbox that extends beyond the slide canvas", () => {
  const invalidManifest = structuredClone(validManifest);
  invalidManifest.elements[0]!.bbox = {
    x: 1200,
    y: 32,
    width: 100,
    height: 64,
  };

  assert.throws(() => SlideManifestSchema.parse(invalidManifest));
});

test("rejects a bbox that extends below the slide canvas", () => {
  const invalidManifest = structuredClone(validManifest);
  invalidManifest.elements[0]!.bbox = {
    x: 40,
    y: 700,
    width: 300,
    height: 40,
  };

  assert.throws(() => SlideManifestSchema.parse(invalidManifest));
});

const validOcrResult = {
  lines: [
    {
      text: "AI-Agent",
      bbox: { x: 40, y: 32, width: 300, height: 64 },
      quad: [
        { x: 40, y: 32 },
        { x: 340, y: 32 },
        { x: 340, y: 96 },
        { x: 40, y: 96 },
      ],
    },
  ],
};

test("parses representative normalized OCR output", () => {
  const parsed = OcrResultSchema.parse(validOcrResult);

  assert.equal(parsed.lines[0]?.text, "AI-Agent");
  assert.equal(parsed.lines[0]?.quad.length, 4);
});

test("rejects OCR quadrilateral points outside the slide canvas", () => {
  const invalidX = structuredClone(validOcrResult);
  invalidX.lines[0]!.quad[1]!.x = 1281;
  const invalidY = structuredClone(validOcrResult);
  invalidY.lines[0]!.quad[2]!.y = -1;

  assert.throws(() => OcrResultSchema.parse(invalidX));
  assert.throws(() => OcrResultSchema.parse(invalidY));
});

test("parses representative vision output", () => {
  const parsed = VisionResultSchema.parse({
    elements: [
      {
        type: "panel",
        bbox: { x: 80, y: 160, width: 240, height: 320 },
        label: "content panel",
        zIndex: 2,
        editableAs: "native-shape",
        confidence: 0.95,
        fillColor: "F4EBDD",
        strokeColor: "23394D",
        cornerRadius: 16,
      },
    ],
  });

  assert.equal(parsed.elements[0]?.type, "panel");
  assert.equal(parsed.elements[0]?.editableAs, "native-shape");
});
