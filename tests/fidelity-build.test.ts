import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import type { FidelityPlan, TextSlideElement } from "../src/contracts.js";
import {
  buildFidelityLayers,
  type FidelityBuildDependencies,
} from "../src/fidelity/build.js";

const repairMetrics = {
  maskedPixels: 4,
  outsideMaskChangedPixels: 0,
  ringSamples: 20,
  ringChannelMad: 1,
  filledPixelDistanceP95: 2,
};

const recompositionMetrics = {
  comparedPixels: 100,
  meanAbsoluteError: 0,
  p95ChannelDelta: 0,
  changedPixelRatio: 0,
};

function textElement(id: string, y: number): TextSlideElement {
  return {
    kind: "text",
    id,
    text: id,
    bbox: { x: 20, y, width: 100, height: 24 },
    rotation: 0,
    color: "23394D",
    fontSizePx: 18,
    align: "left",
    zIndex: 100,
  };
}

function makePlan(iconCount = 2): FidelityPlan {
  const first = textElement("ocr-1", 20);
  const second = textElement("ocr-2", 60);
  return {
    canvas: { width: 1280, height: 720 },
    text: [first, second].map((element) => ({
      kind: "text" as const,
      id: element.id,
      required: true as const,
      element,
    })),
    icons: Array.from({ length: iconCount }, (_, index) => ({
      kind: "icon" as const,
      id: `icon-${index + 1}`,
      label: `icon ${index + 1}`,
      bbox: { x: 200 + index * 100, y: 200, width: 40, height: 40 },
      zIndex: 2 + index,
      sourceElementIndexes: [index],
    })),
    warnings: [],
  };
}

async function fixtures() {
  const source = await sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 4,
      background: "#f7f3e9",
    },
  }).png().toBuffer();
  const mask = await sharp(Buffer.alloc(1280 * 720), {
    raw: { width: 1280, height: 720, channels: 1 },
  }).png().toBuffer();
  const transparentAsset = await sharp({
    create: {
      width: 56,
      height: 56,
      channels: 4,
      background: "#23394d",
    },
  }).png().toBuffer();
  return { source, mask, transparentAsset };
}

function passingDependencies(
  source: Buffer,
  mask: Buffer,
  transparentAsset: Buffer,
): FidelityBuildDependencies {
  return {
    buildTextMask: async () => ({
      mask,
      maskedPixels: 4,
      surfaceRgb: [247, 243, 233],
      glyphRgb: [250, 251, 252],
      glyphBounds: { x: 22, y: 22, width: 80, height: 20 },
      inBoxForegroundCoverage: 0.12,
      estimatedStrokeWidthPx: 1,
    }),
    repair: async () => ({
      image: source,
      accepted: true,
      metrics: repairMetrics,
    }),
    extract: async () => ({
      image: transparentAsset,
      extraction: "transparent",
      metrics: {
        transparentRatio: 0.75,
        opaqueBorderRatio: 0,
        foregroundPixels: 64,
      },
    }),
    buildAssetMask: async () => mask,
    validateRecomposition: async () => ({
      accepted: true,
      preview: source,
      metrics: recompositionMetrics,
    }),
  };
}

test("accepts every required text and only a passing transparent icon", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  let extractionCalls = 0;
  dependencies.extract = async () => {
    extractionCalls += 1;
    return extractionCalls === 1
      ? {
          image: transparentAsset,
          extraction: "transparent" as const,
          metrics: {
            transparentRatio: 0.75,
            opaqueBorderRatio: 0,
            foregroundPixels: 64,
          },
        }
      : {
          image: transparentAsset,
          extraction: "rectangular" as const,
          metrics: {
            transparentRatio: 0,
            opaqueBorderRatio: 1,
            foregroundPixels: 56 * 56,
          },
          fallbackReason: "edge_colors_inconsistent" as const,
        };
  };
  const result = await buildFidelityLayers(
    source,
    makePlan(2),
    dependencies,
  );
  assert.equal(result.manifest.elements.filter((item) => item.kind === "text").length, 2);
  assert.equal(result.manifest.manifestVersion, 1);
  assert.equal(result.manifest.elements.filter((item) => item.kind === "asset").length, 1);
  assert.equal(result.manifest.elements.some((item) => item.kind === "shape"), false);
  assert.equal(result.decisions.length, 4);
  assert.equal(result.assets.size, 1);
  const text = result.manifest.elements.filter((item) => item.kind === "text");
  assert.deepEqual(
    text.map((item) => ({
      text: item.text,
      color: item.color,
      bold: item.bold,
      fontSizePx: item.fontSizePx,
    })),
    [
      { text: "ocr-1", color: "FAFBFC", bold: false, fontSizePx: 18.8 },
      { text: "ocr-2", color: "FAFBFC", bold: false, fontSizePx: 18.8 },
    ],
  );
});

test("passes adaptive text dilation derived from OCR box height", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  const heights = [20, 48, 100];
  const plan = makePlan(0);
  plan.text = heights.map((height, index) => {
    const element = textElement(`adaptive-${index + 1}`, 20 + index * 120);
    element.bbox.height = height;
    return { kind: "text", id: element.id, required: true, element };
  });
  const dilationInputs: Array<number | undefined> = [];
  dependencies.buildTextMask = async (_source, _element, options) => {
    dilationInputs.push(options?.dilationPx);
    return {
      mask,
      maskedPixels: 4,
      surfaceRgb: [247, 243, 233],
      glyphRgb: [35, 57, 77],
      glyphBounds: { x: 22, y: 22, width: 80, height: 20 },
      inBoxForegroundCoverage: 0.12,
      estimatedStrokeWidthPx: 1,
    };
  };

  await buildFidelityLayers(source, plan, dependencies);

  assert.deepEqual(dilationInputs, [1, 2, 3]);
});

test("fails the page when a required text repair is rejected", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  dependencies.repair = async () => ({
    image: source,
    accepted: false,
    reason: "surface_variance_too_high",
    metrics: repairMetrics,
  });
  await assert.rejects(
    buildFidelityLayers(source, makePlan(0), dependencies),
    /Required text ocr-1 could not be repaired safely/,
  );
});

test("keeps a failed icon in the background and continues", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  dependencies.validateRecomposition = async () => ({
    accepted: false,
    preview: source,
    reason: "recomposition_mismatch",
    metrics: { ...recompositionMetrics, p95ChannelDelta: 80 },
  });
  const result = await buildFidelityLayers(
    source,
    makePlan(1),
    dependencies,
  );
  assert.equal(result.manifest.elements.some((item) => item.kind === "asset"), false);
  assert.deepEqual(result.background, source);
  assert.equal(result.decisions.at(-1)?.decision, "kept_in_background");
});

test("retries a clipped icon with wider padding before keeping it in the background", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  const attemptedBboxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  dependencies.extract = async (_input, bbox) => {
    attemptedBboxes.push(bbox);
    if (attemptedBboxes.length < 3) {
      return {
        image: transparentAsset,
        extraction: "rectangular",
        metrics: {
          transparentRatio: 0.5,
          opaqueBorderRatio: 0.1,
          foregroundPixels: 100,
        },
        fallbackReason: "opaque_border_ratio_above_2_percent",
      };
    }
    return {
      image: transparentAsset,
      extraction: "transparent",
      metrics: {
        transparentRatio: 0.75,
        opaqueBorderRatio: 0,
        foregroundPixels: 64,
      },
    };
  };

  const result = await buildFidelityLayers(source, makePlan(1), dependencies);

  assert.deepEqual(attemptedBboxes, [
    { x: 196, y: 196, width: 48, height: 48 },
    { x: 192, y: 192, width: 56, height: 56 },
    { x: 188, y: 188, width: 64, height: 64 },
  ]);
  assert.equal(result.manifest.elements.filter((item) => item.kind === "asset").length, 1);
  assert.deepEqual(result.decisions.at(-1)?.bbox, {
    x: 188,
    y: 188,
    width: 64,
    height: 64,
  });
});

test("rejects an icon repair that changes pixels outside its mask", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  let repairCalls = 0;
  dependencies.repair = async () => {
    repairCalls += 1;
    return {
      image: source,
      accepted: true,
      metrics: {
        ...repairMetrics,
        outsideMaskChangedPixels: repairCalls === 3 ? 1 : 0,
      },
    };
  };

  const result = await buildFidelityLayers(source, makePlan(1), dependencies);

  assert.equal(result.manifest.elements.some((item) => item.kind === "asset"), false);
  assert.deepEqual(result.background, source);
  assert.equal(result.decisions.at(-1)?.decision, "kept_in_background");
  assert.equal(result.decisions.at(-1)?.reason, "outside_mask_changed");
});

test("extracts icons from the source and rejects destructive OCR overlap", async () => {
  const { source, transparentAsset } = await fixtures();
  const rawMask = Buffer.alloc(1280 * 720);
  rawMask[200 * 1280 + 200] = 255;
  const overlapMask = await sharp(rawMask, {
    raw: { width: 1280, height: 720, channels: 1 },
  }).png().toBuffer();
  const dependencies = passingDependencies(
    source,
    overlapMask,
    transparentAsset,
  );
  let extractionInput: Buffer | undefined;
  dependencies.extract = async (input) => {
    extractionInput = input;
    return {
      image: transparentAsset,
      extraction: "transparent",
      metrics: {
        transparentRatio: 0.75,
        opaqueBorderRatio: 0,
        foregroundPixels: 64,
      },
    };
  };
  const result = await buildFidelityLayers(
    source,
    makePlan(1),
    dependencies,
  );
  assert.deepEqual(extractionInput, source);
  assert.equal(result.manifest.elements.some((item) => item.kind === "asset"), false);
  assert.equal(
    result.decisions.at(-1)?.reason,
    "ocr_text_overlap_above_1_percent",
  );
});

test("builds ten required synthetic glyph groups with the real defaults", async () => {
  const width = 1280;
  const height = 720;
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    rgb.set([247, 243, 233], index * 3);
  }
  const elements = Array.from({ length: 10 }, (_, index) =>
    textElement(
      `synthetic-${index + 1}`,
      60 + Math.floor(index / 5) * 120,
    ),
  ).map((element, index) => ({
    ...element,
    bbox: {
      x: 40 + (index % 5) * 230,
      y: element.bbox.y,
      width: 100,
      height: 24,
    },
    zIndex: 100 + index,
  }));
  for (const element of elements) {
    for (let glyph = 0; glyph < 4; glyph += 1) {
      for (let y = element.bbox.y + 5; y < element.bbox.y + 19; y += 1) {
        for (let x = element.bbox.x + 8 + glyph * 18; x < element.bbox.x + 14 + glyph * 18; x += 1) {
          rgb.set([35, 57, 77], (y * width + x) * 3);
        }
      }
    }
  }
  const source = await sharp(rgb, {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
  const plan: FidelityPlan = {
    canvas: { width, height },
    text: elements.map((element) => ({
      kind: "text",
      id: element.id,
      required: true,
      element,
    })),
    icons: [],
    warnings: [],
  };

  const result = await buildFidelityLayers(source, plan);
  assert.equal(result.manifest.elements.filter((item) => item.kind === "text").length, 10);
  assert.equal(result.manifest.elements.some((item) => item.kind === "shape"), false);
  assert.equal(result.decisions.length, 10);
  const [before, after, acceptedMask] = await Promise.all([
    sharp(source).ensureAlpha().raw().toBuffer(),
    sharp(result.background).ensureAlpha().raw().toBuffer(),
    sharp(result.combinedMask).greyscale().raw().toBuffer(),
  ]);
  for (let index = 0; index < width * height; index += 1) {
    if (acceptedMask[index]! >= 128) continue;
    assert.deepEqual(
      after.subarray(index * 4, index * 4 + 4),
      before.subarray(index * 4, index * 4 + 4),
    );
  }
});
