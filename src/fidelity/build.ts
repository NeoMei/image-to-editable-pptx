import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

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

type FileSystemIdentity = {
  dev: bigint;
  ino: bigint;
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
    if (sha256(bytes) !== expectedSha256) {
      throw new Error(`Semantic asset publication hash mismatch: ${name}`);
    }
    return { ...identity, name, sha256: expectedSha256 };
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

async function cleanupOwnedPublication(
  directory: string,
  directoryIdentity: FileSystemIdentity | undefined,
  entries: readonly OwnedPublicationEntry[],
): Promise<void> {
  if (
    directoryIdentity === undefined ||
    !(await directoryHasIdentity(directory, directoryIdentity))
  ) {
    return;
  }
  for (const entry of [...entries].reverse()) {
    if (!(await entryStillOwned(directory, entry))) continue;
    try {
      await unlink(join(directory, entry.name));
    } catch {
      // A concurrent replacement is foreign; leave it untouched.
    }
  }
  if (!(await directoryHasIdentity(directory, directoryIdentity))) return;
  try {
    if ((await readdir(directory)).length === 0) await rmdir(directory);
  } catch {
    // A foreign entry or replacement keeps the directory intentionally intact.
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

    const ownerBytes = Buffer.from(`${JSON.stringify({
      format: "semantic-assets-owner-v1",
      token: randomUUID(),
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
      format: "semantic-assets-complete-v1",
      assets: assets.map((asset, index) => ({
        path: `assets/${stagedNames[index]!}`,
        sha256: sha256(asset.image),
      })),
    })}\n`);
    const completionPath = join(
      finalDirectory,
      SEMANTIC_ASSET_COMPLETION_MARKER,
    );
    await writeFile(completionPath, completionBytes, {
      flag: "wx",
      mode: 0o600,
    });
    ownedEntries.push(
      await inspectPublishedFile(
        completionPath,
        SEMANTIC_ASSET_COMPLETION_MARKER,
        sha256(completionBytes),
      ),
    );
    await verifyPublicationEntries(
      finalDirectory,
      directoryIdentity,
      ownedEntries,
    );
    published = true;
  } finally {
    if (!published) {
      await cleanupOwnedPublication(
        finalDirectory,
        directoryIdentity,
        ownedEntries,
      );
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

const defaultSemanticBuildDependencies: SemanticBuildDependencies = {
  repairCommittedUnion,
  writeAsset: writeFile,
  createAssetsDirectory: async (path) => mkdir(path),
  publishAssetNoReplace,
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
