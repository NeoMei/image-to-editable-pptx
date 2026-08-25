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
  assert.equal(result.manifest.elements.filter((item) => item.kind === "asset").length, 1);
  assert.equal(result.manifest.elements.some((item) => item.kind === "shape"), false);
  assert.equal(result.decisions.length, 4);
  assert.equal(result.assets.size, 1);
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
