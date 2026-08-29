import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import {
  AssetProvenanceSchema,
  CandidateDecisionSchema,
  OcrResultSchema,
  SlideManifestV1Schema,
  SlideManifestV2Schema,
  type AssetProvenance,
  type BBox,
  type CandidateDecision,
  type FidelityPlan,
  type LocalRepairMetrics,
  type LocalRepairResult,
  type OcrResult,
  type RecompositionResult,
  type SlideElement,
  type SlideElementV2,
  type SlideManifest,
  type SlideManifestV2,
  type TextSlideElement,
} from "../contracts.js";
import {
  buildAssetRemovalMask,
  placeAlphaMask,
} from "../image/asset-mask.js";
import { extractAsset } from "../image/extract.js";
import { repairLocalRegion } from "../image/local-repair.js";
import {
  validateRecomposition,
  validateWholePageRecomposition,
} from "../image/recompose.js";
import {
  chooseSemanticMask,
  deriveSemanticMasks,
} from "../image/semantic-mask.js";
import type { SourceCanvas } from "../image/source.js";
import { buildTightTextMask } from "../image/text-mask.js";
import type { CompletedCandidate } from "../occlusion/contracts.js";
import {
  SceneGraphSchema,
  type SceneGraph,
  type SceneRelation,
} from "../scene/contracts.js";
import type {
  SemanticCandidate,
  SemanticLayerPlan,
} from "../scene/plan.js";
import { extractTextBacking } from "./text-backing.js";
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

const ICON_PADDING_ATTEMPTS = [4, 8, 12, 16, 20, 24, 28, 32] as const;

function sameBBox(left: BBox, right: BBox): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
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
    let bbox = expandAndClip(candidate.bbox, ICON_PADDING_ATTEMPTS[0], plan.canvas);
    let extracted = await dependencies.extract(source, bbox, {
      extraction: "transparent",
    });
    for (const padding of ICON_PADDING_ATTEMPTS.slice(1)) {
      if (extracted.extraction === "transparent") break;
      if (extracted.fallbackReason === "transparent_pixel_ratio_above_92_percent") {
        break;
      }
      const expanded = expandAndClip(candidate.bbox, padding, plan.canvas);
      if (sameBBox(expanded, bbox)) continue;
      bbox = expanded;
      extracted = await dependencies.extract(source, bbox, {
        extraction: "transparent",
      });
    }
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
  const manifest = SlideManifestV1Schema.parse({
    manifestVersion: 1,
    canvas: plan.canvas,
    elements: acceptedElements.sort(
      (left, right) => left.zIndex - right.zIndex,
    ),
    warnings: plan.warnings,
  });
  return { background, combinedMask, manifest, assets, decisions };
}

export type BuiltAsset = {
  candidateId: string;
  assetPath: string;
  image: Buffer;
  bbox: BBox;
  removalMask: Buffer;
  zIndex: number;
  reviewRequired: boolean;
  provenance: AssetProvenance;
};

export type SemanticBuildInput = {
  source: SourceCanvas;
  ocr: OcrResult;
  graph: SceneGraph;
  plan: SemanticLayerPlan;
  completions: Map<string, CompletedCandidate>;
  workDir: string;
};

export type SemanticBuildResult = {
  manifest: SlideManifestV2;
  background: Buffer;
  combinedMask: Buffer;
  acceptedAssets: BuiltAsset[];
  decisions: CandidateDecision[];
  recomposition: RecompositionResult;
};

type SemanticStage = {
  candidate: SemanticCandidate;
  image: Buffer;
  bbox: BBox;
  removalMask: Buffer;
  provenance: AssetProvenance;
  reviewRequired: boolean;
  decision: CandidateDecision;
};

type CandidateRejectionReason = NonNullable<CandidateDecision["reason"]>;

const EMPTY_REPAIR_METRICS: LocalRepairMetrics = {
  maskedPixels: 0,
  outsideMaskChangedPixels: 0,
  ringSamples: 0,
  ringChannelMad: 0,
  filledPixelDistanceP95: 0,
};

function sha256(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const difference =
      leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

async function encodeSource(source: SourceCanvas): Promise<Buffer> {
  return sharp(source.rgba, {
    raw: { width: source.width, height: source.height, channels: 4 },
  }).png().toBuffer();
}

function integerCropBounds(
  bbox: BBox,
  canvas: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.floor(bbox.x));
  const top = Math.max(0, Math.floor(bbox.y));
  const right = Math.min(canvas.width, Math.ceil(bbox.x + bbox.width));
  const bottom = Math.min(canvas.height, Math.ceil(bbox.y + bbox.height));
  if (right <= left || bottom <= top) {
    throw new RangeError("Semantic asset bbox does not intersect the canvas");
  }
  return { left, top, width: right - left, height: bottom - top };
}

async function sourceCrop(source: SourceCanvas, bbox: BBox): Promise<Buffer> {
  const crop = integerCropBounds(bbox, source);
  return sharp(source.rgba, {
    raw: { width: source.width, height: source.height, channels: 4 },
  }).extract(crop).png().toBuffer();
}

async function localAlphaMask(image: Buffer): Promise<Buffer> {
  const decoded = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(decoded.info.width * decoded.info.height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = decoded.data[index * decoded.info.channels + 3]!;
  }
  return sharp(alpha, {
    raw: { width: decoded.info.width, height: decoded.info.height, channels: 1 },
  }).png().toBuffer();
}

async function sourceVisibleProvenance(
  source: SourceCanvas,
  bbox: BBox,
  image: Buffer,
  visibleMask: Buffer,
): Promise<AssetProvenance> {
  return AssetProvenanceSchema.parse({
    kind: "source-visible",
    sourceCropSha256: sha256(await sourceCrop(source, bbox)),
    visibleMaskSha256: sha256(visibleMask),
    assetSha256: sha256(image),
  });
}

async function projectLocalMask(
  mask: Buffer,
  bbox: BBox,
  canvas: { width: number; height: number },
): Promise<Buffer> {
  const decoded = await sharp(mask)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== Math.ceil(bbox.width) ||
    decoded.info.height !== Math.ceil(bbox.height)
  ) {
    throw new Error("Semantic mask dimensions do not match its bbox");
  }
  const pixels = new Uint8Array(decoded.info.width * decoded.info.height);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = decoded.data[index * decoded.info.channels]!;
  }
  const projected = placeAlphaMask(
    pixels,
    decoded.info.width,
    decoded.info.height,
    bbox,
    canvas,
  );
  return sharp(projected, {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  }).png().toBuffer();
}

async function maskHasPixels(mask: Buffer): Promise<boolean> {
  const decoded = await sharp(mask)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer();
  return decoded.some((value) => value >= 128);
}

async function outsideMaskUnchanged(
  source: SourceCanvas,
  image: Buffer,
  mask: Buffer,
): Promise<boolean> {
  const [decodedImage, decodedMask] = await Promise.all([
    sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(mask)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  if (
    decodedImage.info.width !== source.width ||
    decodedImage.info.height !== source.height ||
    decodedMask.info.width !== source.width ||
    decodedMask.info.height !== source.height
  ) {
    return false;
  }
  for (let index = 0; index < source.width * source.height; index += 1) {
    if (decodedMask.data[index * decodedMask.info.channels]! >= 128) continue;
    const offset = index * 4;
    if (
      !decodedImage.data
        .subarray(offset, offset + 4)
        .equals(source.rgba.subarray(offset, offset + 4))
    ) {
      return false;
    }
  }
  return true;
}

async function repairCommittedMasks(
  source: Buffer,
  canvas: { width: number; height: number },
  masks: readonly Buffer[],
): Promise<LocalRepairResult> {
  if (masks.length === 0) {
    return {
      image: source,
      accepted: true,
      metrics: EMPTY_REPAIR_METRICS,
    };
  }
  const parent = masks.map((_mask, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const owner = new Int32Array(canvas.width * canvas.height);
  for (const [maskIndex, mask] of masks.entries()) {
    const decoded = await sharp(mask)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== canvas.width || decoded.info.height !== canvas.height) {
      throw new Error("Committed semantic mask dimensions do not match the canvas");
    }
    for (let pixelIndex = 0; pixelIndex < owner.length; pixelIndex += 1) {
      if (decoded.data[pixelIndex * decoded.info.channels]! < 128) continue;
      const previous = owner[pixelIndex]!;
      if (previous === 0) owner[pixelIndex] = maskIndex + 1;
      else union(maskIndex, previous - 1);
    }
  }
  const groups = new Map<number, Buffer[]>();
  for (const [index, mask] of masks.entries()) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(mask);
    groups.set(root, group);
  }

  const sourceDecoded = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.from(sourceDecoded.data);
  const metrics: LocalRepairMetrics = { ...EMPTY_REPAIR_METRICS };
  for (const group of groups.values()) {
    const groupMask = await orMasks(group, canvas);
    const repaired = await repairLocalRegion(source, groupMask);
    metrics.maskedPixels += repaired.metrics.maskedPixels;
    metrics.outsideMaskChangedPixels += repaired.metrics.outsideMaskChangedPixels;
    metrics.ringSamples += repaired.metrics.ringSamples;
    metrics.ringChannelMad = Math.max(
      metrics.ringChannelMad,
      repaired.metrics.ringChannelMad,
    );
    metrics.filledPixelDistanceP95 = Math.max(
      metrics.filledPixelDistanceP95,
      repaired.metrics.filledPixelDistanceP95,
    );
    if (!repaired.accepted || repaired.metrics.outsideMaskChangedPixels !== 0) {
      return {
        image: source,
        accepted: false,
        metrics,
        reason: repaired.reason ?? "filled_pixels_too_different",
      };
    }
    const [repairedDecoded, maskDecoded] = await Promise.all([
      sharp(repaired.image).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(groupMask)
        .removeAlpha()
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
    for (let pixelIndex = 0; pixelIndex < owner.length; pixelIndex += 1) {
      if (maskDecoded.data[pixelIndex * maskDecoded.info.channels]! < 128) continue;
      const offset = pixelIndex * 4;
      repairedDecoded.data.copy(output, offset, offset, offset + 4);
    }
  }
  return {
    image: await sharp(output, {
      raw: { width: canvas.width, height: canvas.height, channels: 4 },
    }).png().toBuffer(),
    accepted: true,
    metrics,
  };
}

function semanticDecision(
  candidate: SemanticCandidate,
  input: {
    decision: CandidateDecision["decision"];
    repairMethod: CandidateDecision["repairMethod"];
    extraction: CandidateDecision["extraction"];
    reason?: CandidateRejectionReason;
    repairMetrics?: LocalRepairMetrics;
    recompositionMetrics?: CandidateDecision["recompositionMetrics"];
    assetPath?: string;
    bbox?: BBox;
  },
): CandidateDecision {
  return CandidateDecisionSchema.parse({
    candidateId: candidate.id,
    kind: candidate.kind,
    decision: input.decision,
    bbox: input.bbox ?? candidate.bbox,
    sourceElementIndexes: [],
    repairMethod: input.repairMethod,
    extraction: input.extraction,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.repairMetrics === undefined
      ? {}
      : { repairMetrics: input.repairMetrics }),
    ...(input.recompositionMetrics === undefined
      ? {}
      : { recompositionMetrics: input.recompositionMetrics }),
    output:
      input.decision === "accepted"
        ? {
            state: "editable_layer",
            manifestElementId: candidate.id,
            ...(input.assetPath === undefined ? {} : { assetPath: input.assetPath }),
          }
        : { state: "kept_in_background" },
  });
}

function assetPathFor(candidate: SemanticCandidate): string {
  const sequence = String(candidate.zOrder + 1).padStart(3, "0");
  const suffix = sha256(Buffer.from(candidate.id)).slice(0, 10);
  return `assets/semantic-${sequence}-${suffix}.png`;
}

async function validateLocalStage(input: {
  source: Buffer;
  removalMask: Buffer;
  image: Buffer;
  bbox: BBox;
  ignoredMask: Buffer;
}): Promise<{
  accepted: boolean;
  reason?: CandidateRejectionReason;
  repairMetrics: LocalRepairMetrics;
  recomposition?: RecompositionResult;
}> {
  const repaired = await repairLocalRegion(input.source, input.removalMask);
  if (!repaired.accepted || repaired.metrics.outsideMaskChangedPixels !== 0) {
    return {
      accepted: false,
      reason:
        repaired.metrics.outsideMaskChangedPixels !== 0
          ? "outside_mask_changed"
          : (repaired.reason ?? "local_repair_failed"),
      repairMetrics: repaired.metrics,
    };
  }
  const recomposition = await validateRecomposition({
    source: input.source,
    background: repaired.image,
    asset: input.image,
    bbox: input.bbox,
    ignoredMask: input.ignoredMask,
  });
  return {
    accepted: recomposition.accepted,
    ...(recomposition.accepted
      ? {}
      : { reason: recomposition.reason ?? "recomposition_mismatch" }),
    repairMetrics: repaired.metrics,
    recomposition,
  };
}

async function validateCompletion(input: {
  source: SourceCanvas;
  bbox: BBox;
  completion: CompletedCandidate;
}): Promise<boolean> {
  if (!input.completion.reviewRequired) return false;
  const parsed = AssetProvenanceSchema.safeParse(input.completion.provenance);
  if (!parsed.success || parsed.data.kind !== "composite") return false;
  if (
    parsed.data.assetSha256 !== sha256(input.completion.image) ||
    parsed.data.visibleMaskSha256 !== sha256(input.completion.visibleMask) ||
    parsed.data.generatedMaskSha256 !== sha256(input.completion.generatedMask) ||
    parsed.data.sourceCropSha256 !== sha256(await sourceCrop(input.source, input.bbox))
  ) {
    return false;
  }
  let image;
  let visible;
  let generated;
  try {
    [image, visible, generated] = await Promise.all([
      sharp(input.completion.image)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(input.completion.visibleMask)
        .removeAlpha()
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(input.completion.generatedMask)
        .removeAlpha()
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
  } catch {
    return false;
  }
  const width = Math.ceil(input.bbox.width);
  const height = Math.ceil(input.bbox.height);
  if (
    image.info.width !== width ||
    image.info.height !== height ||
    visible.info.width !== width ||
    visible.info.height !== height ||
    generated.info.width !== width ||
    generated.info.height !== height
  ) {
    return false;
  }
  const crop = integerCropBounds(input.bbox, input.source);
  if (crop.width !== width || crop.height !== height) return false;
  let visiblePixels = 0;
  let generatedPixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    const isVisible = visible.data[index * visible.info.channels]! >= 16;
    const isGenerated = generated.data[index * generated.info.channels]! >= 16;
    if (isVisible && isGenerated) return false;
    if (isVisible) visiblePixels += 1;
    if (isGenerated) generatedPixels += 1;
    const alpha = image.data[index * image.info.channels + 3]!;
    if (alpha >= 16 && !isVisible && !isGenerated) return false;
    if (!isVisible) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    const sourceOffset = ((crop.top + y) * input.source.width + crop.left + x) * 4;
    const imageOffset = index * image.info.channels;
    if (
      !image.data
        .subarray(imageOffset, imageOffset + 4)
        .equals(input.source.rgba.subarray(sourceOffset, sourceOffset + 4))
    ) {
      return false;
    }
  }
  return visiblePixels > 0 && generatedPixels > 0;
}

function candidateRelations(
  candidate: SemanticCandidate,
  graph: SceneGraph,
): SceneRelation[] {
  const byId = new Map(graph.relations.map((relation) => [relation.id, relation]));
  return candidate.relations
    .map((id) => {
      const relation = byId.get(id);
      if (relation === undefined) {
        throw new Error(`Semantic candidate references an unknown relation: ${id}`);
      }
      return relation;
    })
    .sort((left, right) => compareCodePoints(left.id, right.id));
}

export async function buildSemanticLayers(
  input: SemanticBuildInput,
): Promise<SemanticBuildResult> {
  OcrResultSchema.parse(input.ocr);
  SceneGraphSchema.parse(input.graph);
  if (
    input.source.width !== input.plan.canvas.width ||
    input.source.height !== input.plan.canvas.height ||
    input.graph.canvas.width !== input.plan.canvas.width ||
    input.graph.canvas.height !== input.plan.canvas.height ||
    input.source.rgba.length !== input.source.width * input.source.height * 4
  ) {
    throw new Error("Semantic build source, graph, and plan canvases must match");
  }
  const source = await encodeSource(input.source);
  const textMasks: Buffer[] = [];
  const manifestTexts: TextSlideElement[] = [];
  const decisions: CandidateDecision[] = [];
  for (const textCandidate of input.plan.text) {
    const mask = await buildTightTextMask(source, textCandidate.element, {
      dilationPx: adaptiveTextDilation(textCandidate.element.bbox.height),
    });
    textMasks.push(mask.mask);
    manifestTexts.push({
      ...textCandidate.element,
      color: rgbToHex(mask.glyphRgb),
      ...inferEditableTextStyle(
        textCandidate.element.text,
        textCandidate.element.bbox,
        mask,
      ),
    });
    decisions.push({
      candidateId: textCandidate.id,
      kind: "text",
      decision: "accepted",
      bbox: textCandidate.element.bbox,
      sourceElementIndexes: [],
      repairMethod: "local_nearest_surface",
      extraction: "none",
      output: {
        state: "editable_layer",
        manifestElementId: textCandidate.element.id,
      },
    });
  }
  const protectedTextMask = await orMasks(textMasks, input.plan.canvas);
  const stages: SemanticStage[] = [];
  const textElementsForBacking = manifestTexts.map((text) => ({ ...text }));

  for (const candidate of input.plan.candidates) {
    const path = assetPathFor(candidate);
    if (candidate.kind === "text-backing") {
      const backing = await extractTextBacking(
        input.source,
        candidate,
        textElementsForBacking,
      );
      if (
        !backing.accepted ||
        backing.asset === undefined ||
        backing.assetMask === undefined
      ) {
        decisions.push(
          semanticDecision(candidate, {
            decision: "kept_in_background",
            repairMethod: "none",
            extraction: "none",
            reason: backing.reason ?? "backing_mask_invalid",
          }),
        );
        continue;
      }
      const local = await validateLocalStage({
        source,
        removalMask: backing.assetMask,
        image: backing.asset,
        bbox: candidate.bbox,
        ignoredMask: protectedTextMask,
      });
      if (!local.accepted) {
        decisions.push(
          semanticDecision(candidate, {
            decision: "kept_in_background",
            repairMethod: "local_nearest_surface",
            extraction: "transparent",
            reason: local.reason ?? "recomposition_mismatch",
            repairMetrics: local.repairMetrics,
            recompositionMetrics: local.recomposition?.metrics,
          }),
        );
        continue;
      }
      const provenance = await sourceVisibleProvenance(
        input.source,
        candidate.bbox,
        backing.asset,
        backing.assetMask,
      );
      const decision = semanticDecision(candidate, {
        decision: "accepted",
        repairMethod: "local_nearest_surface",
        extraction: "transparent",
        repairMetrics: local.repairMetrics,
        recompositionMetrics: local.recomposition?.metrics,
        assetPath: path,
      });
      stages.push({
        candidate,
        image: backing.asset,
        bbox: candidate.bbox,
        removalMask: backing.assetMask,
        provenance,
        reviewRequired: false,
        decision,
      });
      decisions.push(decision);
      continue;
    }

    const selected = chooseSemanticMask(
      await deriveSemanticMasks(input.source, candidate),
      protectedTextMask,
    );
    if (selected === undefined) {
      decisions.push(
        semanticDecision(candidate, {
          decision: "kept_in_background",
          repairMethod: "none",
          extraction: "none",
          reason: "semantic_mask_unavailable",
        }),
      );
      continue;
    }
    const completion = input.completions.get(candidate.id);
    if (candidate.occlusion !== undefined) {
      if (completion === undefined) {
        decisions.push(
          semanticDecision(candidate, {
            decision: "kept_in_background",
            repairMethod: "none",
            extraction: "none",
            reason: "occlusion_completion_unavailable",
            bbox: selected.bbox,
          }),
        );
        continue;
      }
      if (
        !(await validateCompletion({
          source: input.source,
          bbox: selected.bbox,
          completion,
        }))
      ) {
        decisions.push(
          semanticDecision(candidate, {
            decision: "kept_in_background",
            repairMethod: "none",
            extraction: "none",
            reason: "completion_provenance_invalid",
            bbox: selected.bbox,
          }),
        );
        continue;
      }
      const removalMask = await projectLocalMask(
        completion.visibleMask,
        selected.bbox,
        input.plan.canvas,
      );
      const decision = semanticDecision(candidate, {
        decision: "accepted",
        repairMethod: "local_nearest_surface",
        extraction: "transparent",
        assetPath: path,
        bbox: selected.bbox,
      });
      stages.push({
        candidate,
        image: completion.image,
        bbox: selected.bbox,
        removalMask,
        provenance: completion.provenance,
        reviewRequired: true,
        decision,
      });
      decisions.push(decision);
      continue;
    }

    const removalMask = await buildAssetRemovalMask(
      selected.mask,
      selected.bbox,
      input.plan.canvas,
    );
    const local = await validateLocalStage({
      source,
      removalMask,
      image: selected.mask,
      bbox: selected.bbox,
      ignoredMask: protectedTextMask,
    });
    if (!local.accepted) {
      decisions.push(
        semanticDecision(candidate, {
          decision: "kept_in_background",
          repairMethod: "local_nearest_surface",
          extraction: "transparent",
          reason: local.reason ?? "recomposition_mismatch",
          repairMetrics: local.repairMetrics,
          recompositionMetrics: local.recomposition?.metrics,
          bbox: selected.bbox,
        }),
      );
      continue;
    }
    const visibleMask = await localAlphaMask(selected.mask);
    const provenance = await sourceVisibleProvenance(
      input.source,
      selected.bbox,
      selected.mask,
      visibleMask,
    );
    const decision = semanticDecision(candidate, {
      decision: "accepted",
      repairMethod: "local_nearest_surface",
      extraction: "transparent",
      repairMetrics: local.repairMetrics,
      recompositionMetrics: local.recomposition?.metrics,
      assetPath: path,
      bbox: selected.bbox,
    });
    stages.push({
      candidate,
      image: selected.mask,
      bbox: selected.bbox,
      removalMask,
      provenance,
      reviewRequired: false,
      decision,
    });
    decisions.push(decision);
  }

  let active = [...stages];
  let background = source;
  let combinedMask = await orMasks(textMasks, input.plan.canvas);
  let recomposition: RecompositionResult | undefined;
  let finalRepairMetrics = EMPTY_REPAIR_METRICS;
  for (let attempt = 0; attempt <= stages.length + 1; attempt += 1) {
    const committedMasks = [
      ...textMasks,
      ...active.map(({ removalMask }) => removalMask),
    ];
    combinedMask = await orMasks(committedMasks, input.plan.canvas);
    if (await maskHasPixels(combinedMask)) {
      const repaired = await repairCommittedMasks(
        source,
        input.plan.canvas,
        committedMasks,
      );
      finalRepairMetrics = repaired.metrics;
      if (
        !repaired.accepted ||
        repaired.metrics.outsideMaskChangedPixels !== 0 ||
        !(await outsideMaskUnchanged(input.source, repaired.image, combinedMask))
      ) {
        if (active.length === 0) {
          throw new Error("Required OCR text could not be repaired safely");
        }
        const reason: CandidateRejectionReason =
          repaired.metrics.outsideMaskChangedPixels !== 0
            ? "outside_mask_changed"
            : (repaired.reason ?? "local_repair_failed");
        for (const stage of active) {
          Object.assign(
            stage.decision,
            semanticDecision(stage.candidate, {
              decision: "kept_in_background",
              repairMethod: "local_nearest_surface",
              extraction: "transparent",
              reason,
              repairMetrics: repaired.metrics,
              bbox: stage.bbox,
            }),
          );
        }
        active = [];
        continue;
      }
      background = repaired.image;
    } else {
      finalRepairMetrics = EMPTY_REPAIR_METRICS;
      background = source;
    }

    recomposition = await validateWholePageRecomposition({
      source,
      background,
      layers: active.map((stage) => ({
        id: stage.candidate.id,
        asset: stage.image,
        bbox: stage.bbox,
        zIndex: stage.candidate.zOrder,
      })),
      ignoredMask: protectedTextMask,
    });
    if (recomposition.accepted) break;
    if (active.length === 0) {
      throw new Error("Required OCR text could not be recomposed safely");
    }
    const deterministicIds = new Set(
      recomposition.attribution === "deterministic"
        ? (recomposition.affectedLayerIds ?? [])
        : [],
    );
    const rollbackIds =
      deterministicIds.size > 0
        ? deterministicIds
        : new Set(active.map(({ candidate }) => candidate.id));
    for (const stage of active) {
      if (!rollbackIds.has(stage.candidate.id)) continue;
      Object.assign(
        stage.decision,
        semanticDecision(stage.candidate, {
          decision: "kept_in_background",
          repairMethod: "local_nearest_surface",
          extraction: "transparent",
          reason: "recomposition_mismatch",
          repairMetrics: finalRepairMetrics,
          recompositionMetrics: recomposition.metrics,
          bbox: stage.bbox,
        }),
      );
    }
    active = active.filter(({ candidate }) => !rollbackIds.has(candidate.id));
  }
  if (recomposition === undefined || !recomposition.accepted) {
    throw new Error("Semantic page recomposition did not converge safely");
  }

  for (const decision of decisions) {
    if (decision.decision !== "accepted") continue;
    decision.repairMetrics = finalRepairMetrics;
    decision.recompositionMetrics = recomposition.metrics;
  }
  const maximumAssetZ = input.plan.candidates.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.zOrder),
    -1,
  );
  const assetElements: SlideElementV2[] = active.map((stage) => ({
    kind: "asset",
    id: stage.candidate.id,
    label: stage.candidate.id,
    bbox: stage.bbox,
    extraction: "transparent",
    assetPath: assetPathFor(stage.candidate),
    zIndex: stage.candidate.zOrder,
    role: stage.candidate.kind,
    groupId:
      stage.candidate.kind === "compound-group" ? stage.candidate.id : null,
    provenance: stage.provenance,
    relations: candidateRelations(stage.candidate, input.graph),
    reviewRequired: stage.reviewRequired,
  }));
  const textElements: SlideElementV2[] = manifestTexts.map((text, index) => ({
    ...text,
    zIndex: maximumAssetZ + index + 1,
  }));
  const manifest = SlideManifestV2Schema.parse({
    manifestVersion: 2,
    canvas: input.plan.canvas,
    elements: [...assetElements, ...textElements].sort(
      (left, right) =>
        left.zIndex - right.zIndex || compareCodePoints(left.id, right.id),
    ),
    warnings: input.plan.warnings,
  });
  const acceptedAssets: BuiltAsset[] = active
    .sort(
      (left, right) =>
        left.candidate.zOrder - right.candidate.zOrder ||
        compareCodePoints(left.candidate.id, right.candidate.id),
    )
    .map((stage) => ({
      candidateId: stage.candidate.id,
      assetPath: assetPathFor(stage.candidate),
      image: stage.image,
      bbox: stage.bbox,
      removalMask: stage.removalMask,
      zIndex: stage.candidate.zOrder,
      reviewRequired: stage.reviewRequired,
      provenance: stage.provenance,
    }));
  await mkdir(join(input.workDir, "assets"), { recursive: true });
  await Promise.all(
    acceptedAssets.map((asset) =>
      writeFile(join(input.workDir, asset.assetPath), asset.image),
    ),
  );
  return {
    manifest,
    background,
    combinedMask,
    acceptedAssets,
    decisions: CandidateDecisionSchema.array().parse(decisions),
    recomposition,
  };
}
