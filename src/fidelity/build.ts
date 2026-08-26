import sharp from "sharp";

import {
  SlideManifestSchema,
  type BBox,
  type CandidateDecision,
  type FidelityPlan,
  type SlideElement,
  type SlideManifest,
} from "../contracts.js";
import { buildAssetRemovalMask } from "../image/asset-mask.js";
import { extractAsset } from "../image/extract.js";
import { repairLocalRegion } from "../image/local-repair.js";
import { validateRecomposition } from "../image/recompose.js";
import { buildTightTextMask } from "../image/text-mask.js";
import { inferEditableTextStyle } from "./text-style.js";

export type FidelityBuildDependencies = {
  buildTextMask: typeof buildTightTextMask;
  repair: typeof repairLocalRegion;
  extract: typeof extractAsset;
  buildAssetMask: typeof buildAssetRemovalMask;
  validateRecomposition: typeof validateRecomposition;
};

export type FidelityBuildResult = {
  background: Buffer;
  combinedMask: Buffer;
  manifest: SlideManifest;
  assets: Map<string, Buffer>;
  decisions: CandidateDecision[];
};

function expandAndClip(
  bbox: BBox,
  padding: number,
  canvas: { width: number; height: number },
): BBox {
  const x = Math.max(0, Math.floor(bbox.x - padding));
  const y = Math.max(0, Math.floor(bbox.y - padding));
  const right = Math.min(canvas.width, Math.ceil(bbox.x + bbox.width + padding));
  const bottom = Math.min(canvas.height, Math.ceil(bbox.y + bbox.height + padding));
  return { x, y, width: right - x, height: bottom - y };
}

async function orMasks(
  masks: readonly Buffer[],
  canvas: { width: number; height: number },
): Promise<Buffer> {
  const output = Buffer.alloc(canvas.width * canvas.height);
  for (const mask of masks) {
    const { data, info } = await sharp(mask)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== canvas.width || info.height !== canvas.height) {
      throw new Error("Candidate mask dimensions do not match the canvas");
    }
    for (let index = 0; index < output.length; index += 1) {
      output[index] = Math.max(output[index]!, data[index * info.channels]!);
    }
  }
  return sharp(output, {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  }).png().toBuffer();
}

async function maskOverlapRatio(
  candidateMask: Buffer,
  protectedTextMask: Buffer,
): Promise<number> {
  const [candidate, protectedText] = await Promise.all([
    sharp(candidateMask)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(protectedTextMask)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  if (
    candidate.info.width !== protectedText.info.width ||
    candidate.info.height !== protectedText.info.height
  ) {
    throw new Error("Candidate and protected-text masks must have equal dimensions");
  }
  let foreground = 0;
  let overlap = 0;
  for (let index = 0; index < candidate.info.width * candidate.info.height; index += 1) {
    const candidateOn = candidate.data[index * candidate.info.channels]! >= 128;
    if (!candidateOn) continue;
    foreground += 1;
    if (protectedText.data[index * protectedText.info.channels]! >= 128) overlap += 1;
  }
  return foreground === 0 ? 0 : overlap / foreground;
}

const defaultDependencies: FidelityBuildDependencies = {
  buildTextMask: buildTightTextMask,
  repair: repairLocalRegion,
  extract: extractAsset,
  buildAssetMask: buildAssetRemovalMask,
  validateRecomposition,
};

function adaptiveTextDilation(height: number): number {
  return Math.min(3, Math.max(1, Math.round(height / 24)));
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  return rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
}

export async function buildFidelityLayers(
  source: Buffer,
  plan: FidelityPlan,
  dependencies: FidelityBuildDependencies = defaultDependencies,
): Promise<FidelityBuildResult> {
  let background = source;
  const acceptedElements: SlideElement[] = [];
  const decisions: CandidateDecision[] = [];
  const assets = new Map<string, Buffer>();
  const acceptedMasks: Buffer[] = [];
  const acceptedTextMasks: Buffer[] = [];

  for (const candidate of plan.text) {
    const mask = await dependencies.buildTextMask(source, candidate.element, {
      dilationPx: adaptiveTextDilation(candidate.element.bbox.height),
    });
    const repaired = await dependencies.repair(background, mask.mask);
    if (!repaired.accepted || repaired.metrics.outsideMaskChangedPixels !== 0) {
      throw new Error(`Required text ${candidate.id} could not be repaired safely`);
    }
    background = repaired.image;
    acceptedMasks.push(mask.mask);
    acceptedTextMasks.push(mask.mask);
    const style = inferEditableTextStyle(
      candidate.element.text,
      candidate.element.bbox,
      mask,
    );
    acceptedElements.push({
      ...candidate.element,
      color: rgbToHex(mask.glyphRgb),
      ...style,
    });
    decisions.push({
      candidateId: candidate.id,
      kind: "text",
      decision: "accepted",
      bbox: candidate.element.bbox,
      sourceElementIndexes: [],
      repairMethod: "local_nearest_surface",
      extraction: "none",
      repairMetrics: repaired.metrics,
      output: {
        state: "editable_layer",
        manifestElementId: candidate.element.id,
      },
    });
  }

  const acceptedTextMask = await orMasks(acceptedTextMasks, plan.canvas);
  for (const candidate of plan.icons) {
    const bbox = expandAndClip(candidate.bbox, 8, plan.canvas);
    const extracted = await dependencies.extract(source, bbox, {
      extraction: "transparent",
    });
    if (extracted.extraction !== "transparent") {
      decisions.push({
        candidateId: candidate.id,
        kind: "icon",
        decision: "kept_in_background",
        bbox,
        sourceElementIndexes: candidate.sourceElementIndexes,
        repairMethod: "none",
        extraction: "none",
        reason: extracted.fallbackReason ?? "transparent_extraction_failed",
        output: { state: "kept_in_background" },
      });
      continue;
    }
    const mask = await dependencies.buildAssetMask(
      extracted.image,
      bbox,
      plan.canvas,
    );
    if ((await maskOverlapRatio(mask, acceptedTextMask)) > 0.01) {
      decisions.push({
        candidateId: candidate.id,
        kind: "icon",
        decision: "kept_in_background",
        bbox,
        sourceElementIndexes: candidate.sourceElementIndexes,
        repairMethod: "none",
        extraction: "transparent",
        reason: "ocr_text_overlap_above_1_percent",
        output: { state: "kept_in_background" },
      });
      continue;
    }
    const repaired = await dependencies.repair(background, mask);
    if (
      !repaired.accepted ||
      repaired.metrics.outsideMaskChangedPixels !== 0
    ) {
      decisions.push({
        candidateId: candidate.id,
        kind: "icon",
        decision: "kept_in_background",
        bbox,
        sourceElementIndexes: candidate.sourceElementIndexes,
        repairMethod: "local_nearest_surface",
        extraction: "transparent",
        reason:
          repaired.metrics.outsideMaskChangedPixels !== 0
            ? "outside_mask_changed"
            : repaired.reason ?? "local_repair_failed",
        repairMetrics: repaired.metrics,
        output: { state: "kept_in_background" },
      });
      continue;
    }
    const recomposed = await dependencies.validateRecomposition({
      source,
      background: repaired.image,
      asset: extracted.image,
      bbox,
      ignoredMask: acceptedTextMask,
    });
    if (!recomposed.accepted) {
      decisions.push({
        candidateId: candidate.id,
        kind: "icon",
        decision: "kept_in_background",
        bbox,
        sourceElementIndexes: candidate.sourceElementIndexes,
        repairMethod: "local_nearest_surface",
        extraction: "transparent",
        reason: recomposed.reason,
        repairMetrics: repaired.metrics,
        recompositionMetrics: recomposed.metrics,
        output: { state: "kept_in_background" },
      });
      continue;
    }
    background = repaired.image;
    acceptedMasks.push(mask);
    const assetPath = `assets/${candidate.id}.png`;
    assets.set(assetPath, extracted.image);
    acceptedElements.push({
      kind: "asset",
      id: candidate.id,
      label: candidate.label,
      bbox,
      extraction: "transparent",
      assetPath,
      zIndex: candidate.zIndex,
    });
    decisions.push({
      candidateId: candidate.id,
      kind: "icon",
      decision: "accepted",
      bbox,
      sourceElementIndexes: candidate.sourceElementIndexes,
      repairMethod: "local_nearest_surface",
      extraction: "transparent",
      repairMetrics: repaired.metrics,
      recompositionMetrics: recomposed.metrics,
      output: {
        state: "editable_layer",
        manifestElementId: candidate.id,
        assetPath,
      },
    });
  }

  const combinedMask = await orMasks(acceptedMasks, plan.canvas);
  const manifest = SlideManifestSchema.parse({
    manifestVersion: 1,
    canvas: plan.canvas,
    elements: acceptedElements.sort(
      (left, right) => left.zIndex - right.zIndex,
    ),
    warnings: plan.warnings,
  });
  return { background, combinedMask, manifest, assets, decisions };
}
