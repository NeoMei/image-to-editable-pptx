import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { OcrResult, VisionResult } from "../src/contracts.js";
import { planFidelityCandidates } from "../src/fidelity/candidates.js";
import { parseQwenOcrResponse } from "../src/providers/qwen-ocr.js";

const ocr: OcrResult = {
  lines: Array.from({ length: 10 }, (_, index) => ({
    text: `text-${index + 1}`,
    bbox: { x: 20, y: 20 + index * 50, width: 120, height: 24 },
    quad: [
      { x: 20, y: 20 + index * 50 },
      { x: 140, y: 20 + index * 50 },
      { x: 140, y: 44 + index * 50 },
      { x: 20, y: 44 + index * 50 },
    ],
  })),
};

const vision: VisionResult = {
  elements: [
    {
      type: "panel",
      bbox: { x: 300, y: 100, width: 300, height: 300 },
      label: "execution panel",
      zIndex: 1,
      editableAs: "native-shape",
      confidence: 0.99,
    },
    {
      type: "icon",
      bbox: { x: 340, y: 160, width: 100, height: 120 },
      label: "wrench",
      zIndex: 2,
      editableAs: "bitmap",
      confidence: 0.99,
    },
    {
      type: "icon",
      bbox: { x: 455, y: 230, width: 70, height: 70 },
      label: "shield",
      zIndex: 3,
      editableAs: "bitmap",
      confidence: 0.98,
    },
    {
      type: "shape",
      bbox: { x: 0, y: 600, width: 1280, height: 100 },
      label: "bottom bar",
      zIndex: 1,
      editableAs: "native-shape",
      confidence: 0.99,
    },
  ],
};

test("plans all OCR text but keeps panels and bars in the background", () => {
  const plan = planFidelityCandidates(ocr, vision);
  assert.equal(plan.text.length, 10);
  assert.equal(plan.text.every((candidate) => candidate.required), true);
  assert.equal(plan.icons.length, 1);
  assert.equal(plan.icons[0]?.label, "wrench + shield");
  assert.deepEqual(plan.icons[0]?.sourceElementIndexes, [1, 2]);
  assert.equal(
    plan.icons.some((candidate) => /panel|bar/i.test(candidate.label)),
    false,
  );
});

test("keeps decorative and uncertain bitmaps in the background", () => {
  const plan = planFidelityCandidates(ocr, {
    elements: [
      ...vision.elements,
      {
        type: "icon",
        bbox: { x: 320, y: 120, width: 20, height: 20 },
        label: "decorative sparkle",
        zIndex: 4,
        editableAs: "bitmap",
        confidence: 0.99,
      },
      {
        type: "illustration",
        bbox: { x: 700, y: 100, width: 200, height: 200 },
        label: "uncertain diagram",
        zIndex: 5,
        editableAs: "bitmap",
        confidence: 0.79,
      },
    ],
  });

  assert.equal(plan.icons.length, 1);
  assert.equal(plan.icons[0]?.label, "wrench + shield");
  assert.deepEqual(plan.icons[0]?.sourceElementIndexes, [1, 2]);
});

test("plans exactly ten required text candidates from the slide 7 OCR fixture", async () => {
  const rawOcr = JSON.parse(
    await readFile(resolve("tests/fixtures/qwen-ocr-slide-07.json"), "utf8"),
  );
  const fixtureOcr = parseQwenOcrResponse(rawOcr);

  const plan = planFidelityCandidates(fixtureOcr, { elements: [] });

  assert.equal(plan.text.length, 10);
  assert.equal(plan.text.every((candidate) => candidate.required), true);
});

test("clips intersecting candidates, omits outside visuals, and warns once", () => {
  const clippedOcr: OcrResult = {
    lines: [
      {
        text: "edge text",
        bbox: { x: 1260, y: 700, width: 40, height: 40 },
        quad: [
          { x: 1260, y: 700 },
          { x: 1300, y: 700 },
          { x: 1300, y: 740 },
          { x: 1260, y: 740 },
        ],
      },
    ],
  };
  const clippedVision: VisionResult = {
    elements: [
      {
        type: "icon",
        bbox: { x: -10, y: 40, width: 50, height: 50 },
        label: "left-edge icon",
        zIndex: 4,
        editableAs: "bitmap",
        confidence: 0.95,
      },
      {
        type: "illustration",
        bbox: { x: 1300, y: 40, width: 30, height: 30 },
        label: "outside illustration",
        zIndex: 5,
        editableAs: "bitmap",
        confidence: 0.95,
      },
    ],
  };

  const plan = planFidelityCandidates(clippedOcr, clippedVision);

  assert.deepEqual(plan.text[0]?.element.bbox, {
    x: 1260,
    y: 700,
    width: 20,
    height: 20,
  });
  assert.equal(plan.icons.length, 1);
  assert.deepEqual(plan.icons[0]?.bbox, {
    x: 0,
    y: 40,
    width: 40,
    height: 50,
  });
  assert.deepEqual(plan.icons[0]?.sourceElementIndexes, [0]);
  assert.deepEqual(plan.warnings, ["out_of_bounds_clipped"]);
});
