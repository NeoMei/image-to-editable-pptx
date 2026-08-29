import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import sharp from "sharp";
import { z } from "zod";

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
  type MaskCandidate,
} from "../image/semantic-mask.js";
import type { SourceCanvas } from "../image/source.js";
import { buildTightTextMask } from "../image/text-mask.js";
import type { CompletedCandidate } from "../occlusion/contracts.js";
import {
  SceneGraphSchema,
  type CanvasSize,
  type SceneGraph,
  type SceneRelation,
} from "../scene/contracts.js";
import type {
  SemanticCandidate,
  SemanticLayerPlan,
} from "../scene/plan.js";
import { toPixelBBox } from "../scene/geometry.js";
import { planSemanticLayers } from "../scene/plan.js";
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

export type CommittedMaskOwner = {
  candidateId: string;
  required: boolean;
  mask: Buffer;
};

export type CommittedUnionRepairInput = {
  source: Buffer;
  canvas: { width: number; height: number };
  unionMask: Buffer;
  owners: readonly CommittedMaskOwner[];
};

export type CommittedUnionRepairResult = LocalRepairResult & {
  attribution: "deterministic" | "ambiguous";
  failingCandidateIds: string[];
};

export type SemanticBuildDependencies = {
  repairCommittedUnion: (
    input: CommittedUnionRepairInput,
  ) => Promise<CommittedUnionRepairResult>;
  writeAsset: (path: string, image: Buffer) => Promise<void>;
  createAssetsDirectory: (path: string) => Promise<void>;
  publishAssetNoReplace: (
    stagedPath: string,
    finalPath: string,
  ) => Promise<void>;
  writeCompletionMarker: (path: string, bytes: Buffer) => Promise<void>;
  validateAssetPublication: (
    directory: string,
  ) => Promise<SemanticAssetPublication>;
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

function addRepairMetrics(total: LocalRepairMetrics, next: LocalRepairMetrics): void {
  total.maskedPixels += next.maskedPixels;
  total.outsideMaskChangedPixels += next.outsideMaskChangedPixels;
  total.ringSamples += next.ringSamples;
  total.ringChannelMad = Math.max(total.ringChannelMad, next.ringChannelMad);
  total.filledPixelDistanceP95 = Math.max(
    total.filledPixelDistanceP95,
    next.filledPixelDistanceP95,
  );
}

export async function repairCommittedUnion(
  input: CommittedUnionRepairInput,
): Promise<CommittedUnionRepairResult> {
  const [unionDecoded, ownerDecoded, sourceDecoded] = await Promise.all([
    sharp(input.unionMask)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    Promise.all(
      input.owners.map(({ mask }) =>
        sharp(mask)
          .removeAlpha()
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true }),
      ),
    ),
    sharp(input.source)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height } = input.canvas;
  if (
    unionDecoded.info.width !== width ||
    unionDecoded.info.height !== height ||
    sourceDecoded.info.width !== width ||
    sourceDecoded.info.height !== height ||
    ownerDecoded.some(({ info }) => info.width !== width || info.height !== height)
  ) {
    throw new Error("Committed semantic mask dimensions do not match the canvas");
  }
  const pixelOwner = new Int32Array(width * height);
  pixelOwner.fill(-1);
  const parent = input.owners.map((_owner, index) => index);
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
  const unionOwners = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const ownerHasPixels = new Uint8Array(input.owners.length);
  for (const [ownerIndex, decoded] of ownerDecoded.entries()) {
    for (let index = 0; index < pixelOwner.length; index += 1) {
      if (decoded.data[index * decoded.info.channels]! < 128) continue;
      ownerHasPixels[ownerIndex] = 1;
      const previousOwner = pixelOwner[index]!;
      if (previousOwner >= 0) unionOwners(ownerIndex, previousOwner);
      else pixelOwner[index] = ownerIndex;
    }
  }
  let unionHasPixels = false;
  for (let index = 0; index < pixelOwner.length; index += 1) {
    const unionOn = unionDecoded.data[index * unionDecoded.info.channels]! >= 128;
    const owned = pixelOwner[index]! >= 0;
    if (unionOn !== owned) {
      throw new Error("Committed union does not match its candidate ownership masks");
    }
    if (unionOn) unionHasPixels = true;
  }
  if (!unionHasPixels) {
    return {
      image: input.source,
      accepted: true,
      metrics: { ...EMPTY_REPAIR_METRICS },
      attribution: "deterministic",
      failingCandidateIds: [],
    };
  }

  const groups = new Map<number, number[]>();
  for (let ownerIndex = 0; ownerIndex < input.owners.length; ownerIndex += 1) {
    if (ownerHasPixels[ownerIndex] === 0) continue;
    const root = find(ownerIndex);
    const members = groups.get(root) ?? [];
    members.push(ownerIndex);
    groups.set(root, members);
  }
  const metrics: LocalRepairMetrics = { ...EMPTY_REPAIR_METRICS };
  const successful: Array<{ mask: Buffer; image: Buffer }> = [];
  const failingCandidateIds = new Set<string>();
  let failureReason: LocalRepairResult["reason"];
  let attribution: CommittedUnionRepairResult["attribution"] = "deterministic";
  for (const ownerIndexes of groups.values()) {
    const groupMask = await orMasks(
      ownerIndexes.map((ownerIndex) => input.owners[ownerIndex]!.mask),
      input.canvas,
    );
    const repaired = await repairLocalRegion(input.source, groupMask);
    addRepairMetrics(metrics, repaired.metrics);
    if (!repaired.accepted || repaired.metrics.outsideMaskChangedPixels !== 0) {
      failureReason ??= repaired.reason ?? "filled_pixels_too_different";
      if (ownerIndexes.length === 0) attribution = "ambiguous";
      for (const ownerIndex of ownerIndexes) {
        failingCandidateIds.add(input.owners[ownerIndex]!.candidateId);
      }
      continue;
    }
    successful.push({ mask: groupMask, image: repaired.image });
  }
  if (failureReason !== undefined) {
    return {
      image: input.source,
      accepted: false,
      metrics,
      reason: failureReason,
      attribution,
      failingCandidateIds: [...failingCandidateIds].sort(compareCodePoints),
    };
  }

  const output = Buffer.from(sourceDecoded.data);
  for (const component of successful) {
    const [decoded, maskDecoded] = await Promise.all([
      sharp(component.image)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(component.mask)
        .removeAlpha()
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
    for (let index = 0; index < pixelOwner.length; index += 1) {
      if (maskDecoded.data[index * maskDecoded.info.channels]! < 128) continue;
      const offset = index * 4;
      decoded.data.copy(output, offset, offset, offset + 4);
    }
  }
  return {
    image: await sharp(output, {
      raw: { width, height, channels: 4 },
    }).png().toBuffer(),
    accepted: true,
    metrics,
    attribution: "deterministic",
    failingCandidateIds: [],
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

export const SEMANTIC_ASSET_OWNERSHIP_MARKER =
  ".semantic-assets-owner.json";
export const SEMANTIC_ASSET_COMPLETION_MARKER =
  ".semantic-assets-complete.json";

const SEMANTIC_ASSET_MARKER_VERSION = 2 as const;
// Version 2 is a cooperating immutable-publication protocol: creating the
// completion marker permanently locks this directory against later mutation.
// The only writer in this module creates paths exclusively and refuses an
// existing assets directory. Readers never modify or delete publication paths.
// Non-cooperating mutation is detected during the held-handle validation
// interval, but no filesystem reader can promise immunity to mutation after it
// returns.
const SEMANTIC_ASSET_READER_PROTOCOL =
  "immutable-completion-lock-v1" as const;
const SemanticAssetDirectoryBindingSchema = z.object({
  dev: z.string().regex(/^\d+$/u),
  ino: z.string().regex(/^\d+$/u),
}).strict();
const SemanticAssetInventoryEntrySchema = z.object({
  path: z.string().regex(/^assets\/[^/\\]+$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const SemanticAssetOwnershipMarkerSchema = z.object({
  markerVersion: z.literal(SEMANTIC_ASSET_MARKER_VERSION),
  kind: z.literal("semantic-assets-owner"),
  readerProtocol: z.literal(SEMANTIC_ASSET_READER_PROTOCOL),
  directory: SemanticAssetDirectoryBindingSchema,
  ownerToken: z.string().uuid(),
  inventory: z.array(SemanticAssetInventoryEntrySchema),
}).strict();
const SemanticAssetCompletionMarkerSchema = z.object({
  markerVersion: z.literal(SEMANTIC_ASSET_MARKER_VERSION),
  kind: z.literal("semantic-assets-complete"),
  readerProtocol: z.literal(SEMANTIC_ASSET_READER_PROTOCOL),
  directory: SemanticAssetDirectoryBindingSchema,
  ownerToken: z.string().uuid(),
  ownershipMarkerSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inventory: z.array(SemanticAssetInventoryEntrySchema),
}).strict();

export type SemanticAssetInventoryEntry = z.infer<
  typeof SemanticAssetInventoryEntrySchema
>;

export type SemanticAssetPublication = {
  markerVersion: typeof SEMANTIC_ASSET_MARKER_VERSION;
  readerProtocol: typeof SEMANTIC_ASSET_READER_PROTOCOL;
  directory: z.infer<typeof SemanticAssetDirectoryBindingSchema>;
  ownerToken: string;
  inventory: SemanticAssetInventoryEntry[];
};

export type SemanticAssetReaderHooks = {
  afterAssetHandlesHashed?: (assetNames: readonly string[]) => Promise<void>;
  beforeFinalInventoryRead?: () => Promise<void>;
};

type FileSystemIdentity = {
  dev: bigint;
  ino: bigint;
};

type FileSystemSnapshot = FileSystemIdentity & {
  size: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type HeldPublishedFile = {
  name: string;
  path: string;
  handle: FileHandle;
  snapshot: FileSystemSnapshot;
  bytes: Buffer;
  sha256: string;
};

type HeldPublishedDirectory = {
  handle: FileHandle;
  snapshot: FileSystemSnapshot;
};

type OwnedPublicationEntry = FileSystemIdentity & {
  name: string;
  sha256: string;
};

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sameIdentity(
  left: FileSystemIdentity,
  right: FileSystemIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function snapshotFileSystemState(stats: BigIntStats): FileSystemSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    nlink: stats.nlink,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameFileSystemSnapshot(
  left: FileSystemSnapshot,
  right: FileSystemSnapshot,
): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readDirectoryIdentity(path: string): Promise<FileSystemIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Semantic assets target is not an owned directory");
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function directoryHasIdentity(
  path: string,
  identity: FileSystemIdentity,
): Promise<boolean> {
  try {
    return sameIdentity(await readDirectoryIdentity(path), identity);
  } catch {
    return false;
  }
}

async function inspectPublishedFile(
  path: string,
  name: string,
  expectedSha256: string,
): Promise<OwnedPublicationEntry> {
  const { bytes, identity } = await readStablePublishedFile(path, name);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`Semantic asset publication hash mismatch: ${name}`);
  }
  return { ...identity, name, sha256: expectedSha256 };
}

async function readStablePublishedFile(
  path: string,
  name: string,
): Promise<{ bytes: Buffer; identity: FileSystemIdentity }> {
  const pathStats = await lstat(path, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw new Error(`Semantic asset publication is contaminated: ${name}`);
  }
  const handle = await open(path, "r");
  try {
    const handleStats = await handle.stat({ bigint: true });
    const identity = { dev: handleStats.dev, ino: handleStats.ino };
    if (!handleStats.isFile() || !sameIdentity(identity, {
      dev: pathStats.dev,
      ino: pathStats.ino,
    })) {
      throw new Error(`Semantic asset publication is contaminated: ${name}`);
    }
    const bytes = await handle.readFile();
    return { bytes, identity };
  } finally {
    await handle.close();
  }
}

async function entryStillOwned(
  directory: string,
  entry: OwnedPublicationEntry,
): Promise<boolean> {
  try {
    const inspected = await inspectPublishedFile(
      join(directory, entry.name),
      entry.name,
      entry.sha256,
    );
    return sameIdentity(inspected, entry);
  } catch {
    return false;
  }
}

async function verifyPublicationEntries(
  directory: string,
  directoryIdentity: FileSystemIdentity,
  entries: readonly OwnedPublicationEntry[],
): Promise<void> {
  if (!(await directoryHasIdentity(directory, directoryIdentity))) {
    throw new Error("Semantic assets directory ownership was lost");
  }
  const expectedNames = entries.map(({ name }) => name).sort(compareCodePoints);
  const actualNames = (await readdir(directory)).sort(compareCodePoints);
  if (!isDeepStrictEqual(actualNames, expectedNames)) {
    throw new Error("Semantic assets directory contains an unexpected entry");
  }
  for (const entry of entries) {
    if (!(await entryStillOwned(directory, entry))) {
      throw new Error(`Semantic asset publication is contaminated: ${entry.name}`);
    }
  }
  const verifiedNames = (await readdir(directory)).sort(compareCodePoints);
  if (!isDeepStrictEqual(verifiedNames, expectedNames)) {
    throw new Error("Semantic assets directory contains an unexpected entry");
  }
}

const HARD_LINK_UNSUPPORTED = new Set([
  "EXDEV",
  "EMLINK",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EPERM",
]);

export async function publishAssetNoReplace(
  stagedPath: string,
  finalPath: string,
): Promise<void> {
  try {
    await link(stagedPath, finalPath);
  } catch (error) {
    if (!HARD_LINK_UNSUPPORTED.has(errnoCode(error) ?? "")) throw error;
    await copyFile(stagedPath, finalPath, fsConstants.COPYFILE_EXCL);
  }
}

function assertCanonicalAssetInventory(
  inventory: readonly SemanticAssetInventoryEntry[],
): void {
  const names = inventory.map(({ path }) => path.slice("assets/".length));
  if (
    new Set(names).size !== names.length ||
    names.includes(SEMANTIC_ASSET_OWNERSHIP_MARKER) ||
    names.includes(SEMANTIC_ASSET_COMPLETION_MARKER)
  ) {
    throw new Error("Semantic asset inventory contains duplicate or reserved paths");
  }
  const sorted = [...inventory].sort((left, right) =>
    compareCodePoints(left.path, right.path),
  );
  if (!isDeepStrictEqual(inventory, sorted)) {
    throw new Error("Semantic asset inventory is not canonical");
  }
}

async function openHeldPublishedDirectory(
  directory: string,
): Promise<HeldPublishedDirectory> {
  const pathStats = await lstat(directory, { bigint: true });
  if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) {
    throw new Error("Semantic assets target is not an owned directory");
  }
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const handleStats = await handle.stat({ bigint: true });
    const pathSnapshot = snapshotFileSystemState(pathStats);
    const handleSnapshot = snapshotFileSystemState(handleStats);
    if (
      !handleStats.isDirectory() ||
      !sameFileSystemSnapshot(pathSnapshot, handleSnapshot)
    ) {
      throw new Error("Semantic assets directory changed while it was opened");
    }
    return { handle, snapshot: handleSnapshot };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readEntireHeldFile(
  handle: FileHandle,
  expectedSize: bigint,
): Promise<Buffer> {
  const size = Number(expectedSize);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Semantic asset publication file is too large to validate");
  }
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      size - offset,
      offset,
    );
    if (bytesRead === 0) {
      throw new Error("Semantic asset publication changed while it was read");
    }
    offset += bytesRead;
  }
  const trailing = Buffer.alloc(1);
  if ((await handle.read(trailing, 0, 1, size)).bytesRead !== 0) {
    throw new Error("Semantic asset publication changed while it was read");
  }
  return bytes;
}

async function openHeldPublishedFile(
  path: string,
  name: string,
  expectedSha256?: string,
): Promise<HeldPublishedFile> {
  const pathStats = await lstat(path, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw new Error(`Semantic asset publication is contaminated: ${name}`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const beforeStats = await handle.stat({ bigint: true });
    const pathSnapshot = snapshotFileSystemState(pathStats);
    const beforeSnapshot = snapshotFileSystemState(beforeStats);
    if (
      !beforeStats.isFile() ||
      !sameFileSystemSnapshot(pathSnapshot, beforeSnapshot)
    ) {
      throw new Error(`Semantic asset publication is contaminated: ${name}`);
    }
    const bytes = await readEntireHeldFile(handle, beforeSnapshot.size);
    const afterStats = await handle.stat({ bigint: true });
    const afterSnapshot = snapshotFileSystemState(afterStats);
    if (
      !afterStats.isFile() ||
      !sameFileSystemSnapshot(beforeSnapshot, afterSnapshot)
    ) {
      throw new Error(`Semantic asset publication changed while reading: ${name}`);
    }
    const actualSha256 = sha256(bytes);
    if (expectedSha256 !== undefined && actualSha256 !== expectedSha256) {
      throw new Error(`Semantic asset publication hash mismatch: ${name}`);
    }
    return {
      name,
      path,
      handle,
      snapshot: afterSnapshot,
      bytes,
      sha256: actualSha256,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertHeldDirectoryStable(
  directory: HeldPublishedDirectory,
): Promise<void> {
  const stats = await directory.handle.stat({ bigint: true });
  if (
    !stats.isDirectory() ||
    !sameFileSystemSnapshot(
      snapshotFileSystemState(stats),
      directory.snapshot,
    )
  ) {
    throw new Error("Semantic asset publication directory changed during validation");
  }
}

async function assertCurrentDirectoryBinding(
  path: string,
  directory: HeldPublishedDirectory,
): Promise<void> {
  const stats = await lstat(path, { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !sameFileSystemSnapshot(
      snapshotFileSystemState(stats),
      directory.snapshot,
    )
  ) {
    throw new Error("Semantic asset publication directory binding changed");
  }
}

async function readHeldDirectoryInventory(
  directory: string,
  heldDirectory: HeldPublishedDirectory,
): Promise<string[]> {
  if (process.platform === "linux") {
    return readdir(`/proc/self/fd/${heldDirectory.handle.fd}`);
  }
  // Node does not accept a FileHandle in readdir and macOS /dev/fd directory
  // descriptors are not enumerable, so sealed-protocol readers use the bound
  // pathname with identity and mutation-epoch checks on both sides.
  return readdir(directory);
}

async function readBoundDirectoryInventory(
  directory: string,
  heldDirectory: HeldPublishedDirectory,
  beforeRead?: () => Promise<void>,
): Promise<string[]> {
  await assertHeldDirectoryStable(heldDirectory);
  await assertCurrentDirectoryBinding(directory, heldDirectory);
  await beforeRead?.();
  const names = await readHeldDirectoryInventory(directory, heldDirectory);
  await assertCurrentDirectoryBinding(directory, heldDirectory);
  await assertHeldDirectoryStable(heldDirectory);
  return names.sort(compareCodePoints);
}

async function revalidateHeldPublishedFile(
  file: HeldPublishedFile,
): Promise<void> {
  const beforeStats = await file.handle.stat({ bigint: true });
  if (
    !beforeStats.isFile() ||
    !sameFileSystemSnapshot(
      snapshotFileSystemState(beforeStats),
      file.snapshot,
    )
  ) {
    throw new Error(`Semantic asset publication changed during validation: ${file.name}`);
  }
  const bytes = await readEntireHeldFile(file.handle, file.snapshot.size);
  const afterStats = await file.handle.stat({ bigint: true });
  if (
    !afterStats.isFile() ||
    !sameFileSystemSnapshot(
      snapshotFileSystemState(afterStats),
      file.snapshot,
    ) ||
    sha256(bytes) !== file.sha256
  ) {
    throw new Error(`Semantic asset publication changed during validation: ${file.name}`);
  }
  const pathStats = await lstat(file.path, { bigint: true });
  if (
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    !sameFileSystemSnapshot(
      snapshotFileSystemState(pathStats),
      file.snapshot,
    )
  ) {
    throw new Error(`Semantic asset publication path binding changed: ${file.name}`);
  }
}

async function readSemanticAssetPublicationUnchecked(
  directory: string,
  hooks: SemanticAssetReaderHooks,
): Promise<SemanticAssetPublication> {
  const heldDirectory = await openHeldPublishedDirectory(directory);
  const heldFiles: HeldPublishedFile[] = [];
  try {
    const ownerFile = await openHeldPublishedFile(
      join(directory, SEMANTIC_ASSET_OWNERSHIP_MARKER),
      SEMANTIC_ASSET_OWNERSHIP_MARKER,
    );
    heldFiles.push(ownerFile);
    const completionFile = await openHeldPublishedFile(
      join(directory, SEMANTIC_ASSET_COMPLETION_MARKER),
      SEMANTIC_ASSET_COMPLETION_MARKER,
    );
    heldFiles.push(completionFile);
    const owner = SemanticAssetOwnershipMarkerSchema.parse(
      JSON.parse(ownerFile.bytes.toString("utf8")),
    );
    const completion = SemanticAssetCompletionMarkerSchema.parse(
      JSON.parse(completionFile.bytes.toString("utf8")),
    );
    assertCanonicalAssetInventory(owner.inventory);
    assertCanonicalAssetInventory(completion.inventory);

    const currentDirectory = {
      dev: heldDirectory.snapshot.dev.toString(),
      ino: heldDirectory.snapshot.ino.toString(),
    };
    if (
      !isDeepStrictEqual(owner.directory, currentDirectory) ||
      !isDeepStrictEqual(completion.directory, currentDirectory) ||
      owner.readerProtocol !== completion.readerProtocol ||
      owner.ownerToken !== completion.ownerToken ||
      !isDeepStrictEqual(owner.inventory, completion.inventory) ||
      completion.ownershipMarkerSha256 !== ownerFile.sha256
    ) {
      throw new Error("Semantic asset marker ownership binding does not match");
    }

    const expectedNames = [
      SEMANTIC_ASSET_OWNERSHIP_MARKER,
      SEMANTIC_ASSET_COMPLETION_MARKER,
      ...completion.inventory.map(({ path }) => path.slice("assets/".length)),
    ].sort(compareCodePoints);
    if (
      !isDeepStrictEqual(
        await readBoundDirectoryInventory(directory, heldDirectory),
        expectedNames,
      )
    ) {
      throw new Error("Semantic asset publication inventory is not exact");
    }

    const assetFiles: HeldPublishedFile[] = [];
    for (const entry of completion.inventory) {
      const name = entry.path.slice("assets/".length);
      const file = await openHeldPublishedFile(
        join(directory, name),
        name,
        entry.sha256,
      );
      heldFiles.push(file);
      assetFiles.push(file);
    }
    await hooks.afterAssetHandlesHashed?.(
      assetFiles.map(({ name }) => name),
    );

    for (const file of heldFiles) await revalidateHeldPublishedFile(file);
    if (
      !isDeepStrictEqual(
        await readBoundDirectoryInventory(
          directory,
          heldDirectory,
          hooks.beforeFinalInventoryRead,
        ),
        expectedNames,
      )
    ) {
      throw new Error("Semantic asset publication inventory is not exact");
    }
    for (const file of heldFiles) await revalidateHeldPublishedFile(file);
    // With the completion lock honored, the successful held-directory fstat
    // below is the reader's linearization point. The following pathname check
    // proves the caller-visible name remained bound through that point.
    await assertHeldDirectoryStable(heldDirectory);
    await assertCurrentDirectoryBinding(directory, heldDirectory);

    return {
      markerVersion: SEMANTIC_ASSET_MARKER_VERSION,
      readerProtocol: SEMANTIC_ASSET_READER_PROTOCOL,
      directory: currentDirectory,
      ownerToken: owner.ownerToken,
      inventory: completion.inventory.map((entry) => ({ ...entry })),
    };
  } finally {
    await Promise.allSettled(heldFiles.map(({ handle }) => handle.close()));
    await heldDirectory.handle.close();
  }
}

export async function readSemanticAssetPublication(
  directory: string,
  hooks: SemanticAssetReaderHooks = {},
): Promise<SemanticAssetPublication> {
  try {
    return await readSemanticAssetPublicationUnchecked(directory, hooks);
  } catch (error) {
    throw new Error("Invalid semantic asset publication ownership or inventory", {
      cause: error,
    });
  }
}

async function assertAssetsTargetAbsent(workDir: string): Promise<void> {
  try {
    await lstat(join(workDir, "assets"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Semantic assets target already exists");
}

async function publishSemanticAssets(
  workDir: string,
  assets: readonly BuiltAsset[],
  dependencies: SemanticBuildDependencies,
): Promise<void> {
  await assertAssetsTargetAbsent(workDir);
  const stagingDir = await mkdtemp(join(workDir, ".semantic-assets-staging-"));
  const finalDirectory = join(workDir, "assets");
  let directoryIdentity: FileSystemIdentity | undefined;
  const ownedEntries: OwnedPublicationEntry[] = [];
  let published = false;
  try {
    const stagedNames: string[] = [];
    for (const asset of assets) {
      if (!asset.assetPath.startsWith("assets/")) {
        throw new Error("Semantic asset path must be under assets");
      }
      const fileName = asset.assetPath.slice("assets/".length);
      if (fileName.length === 0 || fileName.includes("/") || fileName === ".") {
        throw new Error("Semantic asset path must name one staged file");
      }
      const stagedPath = join(stagingDir, fileName);
      await dependencies.writeAsset(stagedPath, asset.image);
      await inspectPublishedFile(stagedPath, fileName, sha256(asset.image));
      stagedNames.push(fileName);
    }
    await assertAssetsTargetAbsent(workDir);
    try {
      await dependencies.createAssetsDirectory(finalDirectory);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") {
        throw new Error("Semantic assets target already exists", { cause: error });
      }
      throw error;
    }
    directoryIdentity = await readDirectoryIdentity(finalDirectory);

    const directoryBinding = {
      dev: directoryIdentity.dev.toString(),
      ino: directoryIdentity.ino.toString(),
    };
    const ownerToken = randomUUID();
    const inventory: SemanticAssetInventoryEntry[] = assets
      .map((asset, index) => ({
        path: `assets/${stagedNames[index]!}`,
        sha256: sha256(asset.image),
      }))
      .sort((left, right) => compareCodePoints(left.path, right.path));
    assertCanonicalAssetInventory(inventory);

    const ownerBytes = Buffer.from(`${JSON.stringify({
      markerVersion: SEMANTIC_ASSET_MARKER_VERSION,
      kind: "semantic-assets-owner",
      readerProtocol: SEMANTIC_ASSET_READER_PROTOCOL,
      directory: directoryBinding,
      ownerToken,
      inventory,
    })}\n`);
    const ownerPath = join(finalDirectory, SEMANTIC_ASSET_OWNERSHIP_MARKER);
    await writeFile(ownerPath, ownerBytes, { flag: "wx", mode: 0o600 });
    ownedEntries.push(
      await inspectPublishedFile(
        ownerPath,
        SEMANTIC_ASSET_OWNERSHIP_MARKER,
        sha256(ownerBytes),
      ),
    );

    for (const [index, asset] of assets.entries()) {
      if (!(await directoryHasIdentity(finalDirectory, directoryIdentity))) {
        throw new Error("Semantic assets directory ownership was lost");
      }
      const fileName = stagedNames[index]!;
      const finalPath = join(finalDirectory, fileName);
      await dependencies.publishAssetNoReplace(
        join(stagingDir, fileName),
        finalPath,
      );
      ownedEntries.push(
        await inspectPublishedFile(finalPath, fileName, sha256(asset.image)),
      );
    }
    await verifyPublicationEntries(
      finalDirectory,
      directoryIdentity,
      ownedEntries,
    );
    await rm(stagingDir, { recursive: true, force: true });

    const completionBytes = Buffer.from(`${JSON.stringify({
      markerVersion: SEMANTIC_ASSET_MARKER_VERSION,
      kind: "semantic-assets-complete",
      readerProtocol: SEMANTIC_ASSET_READER_PROTOCOL,
      directory: directoryBinding,
      ownerToken,
      ownershipMarkerSha256: sha256(ownerBytes),
      inventory,
    })}\n`);
    const completionPath = join(
      finalDirectory,
      SEMANTIC_ASSET_COMPLETION_MARKER,
    );
    await dependencies.writeCompletionMarker(completionPath, completionBytes);
    const validated = await dependencies.validateAssetPublication(finalDirectory);
    if (
      !isDeepStrictEqual(validated.directory, directoryBinding) ||
      validated.ownerToken !== ownerToken ||
      !isDeepStrictEqual(validated.inventory, inventory)
    ) {
      throw new Error("Semantic asset publication validation did not match the build");
    }
    published = true;
  } finally {
    if (!published) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
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

function compoundMemberCandidates(
  candidate: SemanticCandidate,
  graph: SceneGraph,
  canvas: CanvasSize,
): SemanticCandidate[] {
  if (candidate.kind !== "compound-group") return [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const members: SemanticCandidate[] = [];
  for (const nodeId of candidate.nodeIds) {
    const node = nodeById.get(nodeId);
    if (node === undefined) {
      throw new Error(`Semantic candidate references an unknown scene node: ${nodeId}`);
    }
    if (node.id === candidate.id) continue;
    if (node.role !== "foreground-object" && node.role !== "compound-group") continue;
    members.push({
      id: `${candidate.id}:${nodeId}`,
      kind: node.role === "compound-group" ? "compound-group" : "foreground-object",
      nodeIds: [nodeId],
      bbox: toPixelBBox(node.bbox, canvas),
      zOrder: node.zIndex ?? candidate.zOrder,
      relations: graph.relations
        .filter(({ from, to }) => from === nodeId || to === nodeId)
        .map(({ id: relationId }) => relationId)
        .sort(compareCodePoints),
      carriedTextIds: [],
    });
  }
  return members.sort((left, right) => compareCodePoints(left.id, right.id));
}

const defaultSemanticBuildDependencies: SemanticBuildDependencies = {
  repairCommittedUnion,
  writeAsset: writeFile,
  createAssetsDirectory: async (path) => mkdir(path),
  publishAssetNoReplace,
  writeCompletionMarker: async (path, bytes) =>
    writeFile(path, bytes, { flag: "wx", mode: 0o600 }),
  validateAssetPublication: readSemanticAssetPublication,
};

export async function buildSemanticLayers(
  input: SemanticBuildInput,
  dependencyOverrides: Partial<SemanticBuildDependencies> = {},
): Promise<SemanticBuildResult> {
  OcrResultSchema.parse(input.ocr);
  SceneGraphSchema.parse(input.graph);
  const canonicalPlan = planSemanticLayers(input.graph, input.ocr);
  if (!isDeepStrictEqual(input.plan, canonicalPlan)) {
    throw new Error("Supplied semantic plan must exactly match the canonical semantic plan");
  }
  const plan = canonicalPlan;
  const dependencies: SemanticBuildDependencies = {
    ...defaultSemanticBuildDependencies,
    ...dependencyOverrides,
  };
  if (
    input.source.width !== plan.canvas.width ||
    input.source.height !== plan.canvas.height ||
    input.graph.canvas.width !== plan.canvas.width ||
    input.graph.canvas.height !== plan.canvas.height ||
    input.source.rgba.length !== input.source.width * input.source.height * 4
  ) {
    throw new Error("Semantic build source, graph, and plan canvases must match");
  }
  await assertAssetsTargetAbsent(input.workDir);
  const source = await encodeSource(input.source);
  const textMasks: Buffer[] = [];
  const manifestTexts: TextSlideElement[] = [];
  const decisions: CandidateDecision[] = [];
  for (const textCandidate of plan.text) {
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
  const protectedTextMask = await orMasks(textMasks, plan.canvas);
  const stages: SemanticStage[] = [];
  const textElementsForBacking = manifestTexts.map((text) => ({ ...text }));

  const commitSourceVisibleStage = async (
    candidate: SemanticCandidate,
    selected: MaskCandidate,
  ): Promise<void> => {
    const removalMask = await buildAssetRemovalMask(
      selected.mask,
      selected.bbox,
      plan.canvas,
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
      return;
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
      assetPath: assetPathFor(candidate),
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
  };

  for (const candidate of plan.candidates) {
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
      for (const member of compoundMemberCandidates(candidate, input.graph, plan.canvas)) {
        const memberSelected = chooseSemanticMask(
          await deriveSemanticMasks(input.source, member),
          protectedTextMask,
        );
        if (memberSelected === undefined) {
          decisions.push(
            semanticDecision(member, {
              decision: "kept_in_background",
              repairMethod: "none",
              extraction: "none",
              reason: "semantic_mask_unavailable",
            }),
          );
          continue;
        }
        await commitSourceVisibleStage(member, memberSelected);
      }
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
        plan.canvas,
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

    await commitSourceVisibleStage(candidate, selected);
  }

  let active = [...stages];
  let background = source;
  let combinedMask = await orMasks(textMasks, plan.canvas);
  let recomposition: RecompositionResult | undefined;
  let finalRepairMetrics = EMPTY_REPAIR_METRICS;
  for (let attempt = 0; attempt <= stages.length + 1; attempt += 1) {
    const committedOwners: CommittedMaskOwner[] = [
      ...plan.text.map((textCandidate, index) => ({
        candidateId: textCandidate.id,
        required: true,
        mask: textMasks[index]!,
      })),
      ...active.map(({ candidate, removalMask }) => ({
        candidateId: candidate.id,
        required: false,
        mask: removalMask,
      })),
    ];
    combinedMask = await orMasks(
      committedOwners.map(({ mask }) => mask),
      plan.canvas,
    );
    const repaired = await dependencies.repairCommittedUnion({
      source,
      canvas: plan.canvas,
      unionMask: combinedMask,
      owners: committedOwners,
    });
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
      const knownOwnerIds = new Set(
        committedOwners.map(({ candidateId }) => candidateId),
      );
      const exactFailure =
        repaired.attribution === "deterministic" &&
        repaired.failingCandidateIds.length > 0 &&
        repaired.failingCandidateIds.every((id) => knownOwnerIds.has(id));
      const reportedIds = new Set(repaired.failingCandidateIds);
      const rollbackIds = new Set(
        active
          .filter(({ candidate }) =>
            exactFailure ? reportedIds.has(candidate.id) : true,
          )
          .map(({ candidate }) => candidate.id),
      );
      if (rollbackIds.size === 0) {
        throw new Error("Required OCR text could not be repaired safely");
      }
      for (const stage of active) {
        if (!rollbackIds.has(stage.candidate.id)) continue;
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
      active = active.filter(({ candidate }) => !rollbackIds.has(candidate.id));
      continue;
    }
    background = repaired.image;

    recomposition = await validateWholePageRecomposition({
      source,
      background,
      layers: active.map((stage) => ({
        id: stage.candidate.id,
        asset: stage.image,
        bbox: stage.bbox,
        zIndex: stage.candidate.zOrder,
        strict: stage.reviewRequired,
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
  const maximumAssetZ = plan.candidates.reduce(
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
    canvas: plan.canvas,
    elements: [...assetElements, ...textElements].sort(
      (left, right) =>
        left.zIndex - right.zIndex || compareCodePoints(left.id, right.id),
    ),
    warnings: plan.warnings,
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
  const parsedDecisions = CandidateDecisionSchema.array().parse(decisions);
  await publishSemanticAssets(input.workDir, acceptedAssets, dependencies);
  return {
    manifest,
    background,
    combinedMask,
    acceptedAssets,
    decisions: parsedDecisions,
    recomposition,
  };
}
