import sharp from "sharp";

import type { BBox, TextSlideElement } from "../contracts.js";
import { placeAlphaMask } from "../image/asset-mask.js";
import { repairLocalRegion } from "../image/local-repair.js";
import {
  chooseSemanticMask,
  deriveSemanticMasks,
  type MaskCandidate,
} from "../image/semantic-mask.js";
import type { SourceCanvas } from "../image/source.js";
import { buildTightTextMask } from "../image/text-mask.js";
import type { SemanticCandidate } from "../scene/plan.js";

const MASK_FOREGROUND_ALPHA = 16;
const SURFACE_FOREGROUND_ALPHA = 128;
const MAX_SURFACE_RESIDUAL_P95 = 18;
const MAX_RESIDUAL_GLYPH_RATIO = 0.02;
const MIN_REMOVED_GLYPH_DELTA = 24;
const MAX_SEAM_CONTRAST_P95 = 8;

export type TextBackingResult = {
  accepted: boolean;
  asset?: Buffer;
  assetMask?: Buffer;
  repairedSource?: Buffer;
  textNodeIds: string[];
  metrics: {
    residualGlyphRatio: number;
    outsideBackingChangedPixels: number;
    seamContrastP95: number;
  };
  reason?:
    | "backing_mask_invalid"
    | "glyph_residue"
    | "repair_seam"
    | "surface_unstable";
};

type Decoded = {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
};

type Metrics = TextBackingResult["metrics"];
type RejectionReason = NonNullable<TextBackingResult["reason"]>;

function resolveCarriedTexts(
  candidate: SemanticCandidate,
  texts: readonly TextSlideElement[],
): { carried: TextSlideElement[]; valid: boolean } {
  const byId = new Map<string, TextSlideElement>();
  for (const text of texts) {
    if (byId.has(text.id)) return { carried: [], valid: false };
    byId.set(text.id, text);
  }
  if (candidate.carriedTextIds.length === 0) return { carried: [], valid: false };
  const uniqueIds = new Set(candidate.carriedTextIds);
  if (uniqueIds.size !== candidate.carriedTextIds.length) {
    return { carried: [], valid: false };
  }
  const carried = candidate.carriedTextIds.flatMap((id) => {
    const text = byId.get(id);
    return text === undefined ? [] : [text];
  });
  return { carried, valid: carried.length === candidate.carriedTextIds.length };
}

function bboxOverlapsBacking(
  bbox: BBox,
  backing: Uint8Array,
  canvas: SourceCanvas,
): boolean {
  const left = Math.max(0, Math.floor(bbox.x));
  const top = Math.max(0, Math.floor(bbox.y));
  const right = Math.min(canvas.width, Math.ceil(bbox.x + bbox.width));
  const bottom = Math.min(canvas.height, Math.ceil(bbox.y + bbox.height));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (
        x < bbox.x + bbox.width &&
        x + 1 > bbox.x &&
        y < bbox.y + bbox.height &&
        y + 1 > bbox.y &&
        backing[y * canvas.width + x]! >= MASK_FOREGROUND_ALPHA
      ) {
        return true;
      }
    }
  }
  return false;
}

function rejected(
  textNodeIds: string[],
  reason: RejectionReason,
  metrics: Metrics = {
    residualGlyphRatio: 0,
    outsideBackingChangedPixels: 0,
    seamContrastP95: 0,
  },
): TextBackingResult {
  return { accepted: false, textNodeIds, metrics, reason };
}

async function decodeRgba(image: Buffer): Promise<Decoded> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

async function decodeGreyscale(image: Buffer): Promise<Decoded> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

async function encodeGreyscale(
  data: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function projectMask(
  mask: MaskCandidate,
  canvas: SourceCanvas,
): Promise<{ encoded: Buffer; alpha: Uint8Array; local: Decoded }> {
  const local = await decodeRgba(mask.mask);
  const alpha = new Uint8Array(local.width * local.height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = local.data[index * local.channels + 3]!;
  }
  const projected = placeAlphaMask(
    alpha,
    local.width,
    local.height,
    mask.bbox,
    canvas,
  );
  return {
    encoded: await encodeGreyscale(projected, canvas.width, canvas.height),
    alpha: projected,
    local,
  };
}

async function emptyMask(canvas: SourceCanvas): Promise<Buffer> {
  return encodeGreyscale(
    new Uint8Array(canvas.width * canvas.height),
    canvas.width,
    canvas.height,
  );
}

async function unionMasks(
  masks: readonly Buffer[],
  width: number,
  height: number,
): Promise<{ encoded: Buffer; pixels: Uint8Array }> {
  const pixels = new Uint8Array(width * height);
  for (const mask of masks) {
    const decoded = await decodeGreyscale(mask);
    if (decoded.width !== width || decoded.height !== height) {
      throw new RangeError("Text and backing masks must match the source canvas");
    }
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = Math.max(pixels[index]!, decoded.data[index * decoded.channels]!);
    }
  }
  return { encoded: await encodeGreyscale(pixels, width, height), pixels };
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((left, right) => left - right);
  return values[Math.ceil(values.length * 0.95) - 1]!;
}

function maxChannelDelta(data: Buffer, leftIndex: number, rightIndex: number): number {
  return Math.max(
    ...[0, 1, 2].map((channel) =>
      Math.abs(data[leftIndex * 4 + channel]! - data[rightIndex * 4 + channel]!),
    ),
  );
}

function maxChannelDeltaBetween(
  left: Buffer,
  right: Buffer,
  index: number,
): number {
  return Math.max(
    ...[0, 1, 2].map((channel) =>
      Math.abs(left[index * 4 + channel]! - right[index * 4 + channel]!),
    ),
  );
}

function solveLinearSystem(matrix: number[][], values: number[]): number[] | undefined {
  const rows = matrix.map((row, index) => [...row, values[index]!]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column]!) < 1e-9) return undefined;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const divisor = rows[column]![column]!;
    for (let index = column; index < 4; index += 1) rows[column]![index]! /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = rows[row]![column]!;
      for (let index = column; index < 4; index += 1) {
        rows[row]![index]! -= factor * rows[column]![index]!;
      }
    }
  }
  return rows.map((row) => row[3]!);
}

function surfaceResidualP95(
  rgba: Buffer,
  backing: Uint8Array,
  excluded: Uint8Array,
  width: number,
  height: number,
): number {
  const samples: Array<{ x: number; y: number; index: number }> = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      if (
        backing[index]! < SURFACE_FOREGROUND_ALPHA ||
        excluded[index]! >= MASK_FOREGROUND_ALPHA ||
        backing[index - 1]! < SURFACE_FOREGROUND_ALPHA ||
        backing[index + 1]! < SURFACE_FOREGROUND_ALPHA ||
        backing[index - width]! < SURFACE_FOREGROUND_ALPHA ||
        backing[index + width]! < SURFACE_FOREGROUND_ALPHA
      ) {
        continue;
      }
      samples.push({ x, y, index });
    }
  }
  if (samples.length < 16) return Number.POSITIVE_INFINITY;
  const minX = Math.min(...samples.map(({ x }) => x));
  const maxX = Math.max(...samples.map(({ x }) => x));
  const minY = Math.min(...samples.map(({ y }) => y));
  const maxY = Math.max(...samples.map(({ y }) => y));
  const scaleX = Math.max(1, maxX - minX);
  const scaleY = Math.max(1, maxY - minY);
  const normalized = (x: number, y: number) => ({
    x: (x - minX) / scaleX,
    y: (y - minY) / scaleY,
  });
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  for (const sample of samples) {
    const { x, y } = normalized(sample.x, sample.y);
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
    sumYY += y * y;
  }
  const matrix = [
    [samples.length, sumX, sumY],
    [sumX, sumXX, sumXY],
    [sumY, sumXY, sumYY],
  ];
  const coefficients: number[][] = [];
  for (let channel = 0; channel < 3; channel += 1) {
    let sumValue = 0;
    let sumXValue = 0;
    let sumYValue = 0;
    for (const sample of samples) {
      const { x, y } = normalized(sample.x, sample.y);
      const value = rgba[sample.index * 4 + channel]!;
      sumValue += value;
      sumXValue += x * value;
      sumYValue += y * value;
    }
    const solved = solveLinearSystem(matrix, [sumValue, sumXValue, sumYValue]);
    if (solved === undefined) return Number.POSITIVE_INFINITY;
    coefficients.push(solved);
  }
  const residuals = samples.map((sample) =>
    {
      const { x, y } = normalized(sample.x, sample.y);
      return Math.max(
        ...coefficients.map((channel, channelIndex) =>
          Math.abs(
            rgba[sample.index * 4 + channelIndex]! -
              (channel[0]! + channel[1]! * x + channel[2]! * y),
          ),
        ),
      );
    },
  );
  return percentile95(residuals);
}

function repairMetrics(
  before: Buffer,
  after: Buffer,
  backing: Uint8Array,
  repair: Uint8Array,
  coreGlyph: Uint8Array,
  width: number,
  height: number,
): Metrics {
  let outsideBackingChangedPixels = 0;
  let glyphPixels = 0;
  let residualGlyphPixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    if (backing[index]! < MASK_FOREGROUND_ALPHA) {
      if (!before.subarray(index * 4, index * 4 + 4).equals(after.subarray(index * 4, index * 4 + 4))) {
        outsideBackingChangedPixels += 1;
      }
    }
    if (coreGlyph[index]! >= MASK_FOREGROUND_ALPHA) {
      glyphPixels += 1;
      if (maxChannelDeltaBetween(before, after, index) < MIN_REMOVED_GLYPH_DELTA) {
        residualGlyphPixels += 1;
      }
    }
  }
  const seamContrasts: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (repair[index]! < MASK_FOREGROUND_ALPHA) continue;
      for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const neighbor = nextY * width + nextX;
        if (
          repair[neighbor]! < MASK_FOREGROUND_ALPHA &&
          backing[neighbor]! >= SURFACE_FOREGROUND_ALPHA
        ) {
          seamContrasts.push(maxChannelDelta(after, index, neighbor));
        }
      }
    }
  }
  return {
    residualGlyphRatio: glyphPixels === 0 ? 1 : residualGlyphPixels / glyphPixels,
    outsideBackingChangedPixels,
    seamContrastP95: percentile95(seamContrasts),
  };
}

function buildCandidateAsset(
  local: Decoded,
  localBBox: BBox,
  candidateBBox: BBox,
  repaired: Buffer,
  repairMask: Uint8Array,
  canvas: SourceCanvas,
): { rgba: Buffer; width: number; height: number } {
  const width = Math.ceil(candidateBBox.width);
  const height = Math.ceil(candidateBBox.height);
  const output = Buffer.alloc(width * height * 4);
  const localLeft = Math.floor(localBBox.x);
  const localTop = Math.floor(localBBox.y);
  const candidateLeft = Math.floor(candidateBBox.x);
  const candidateTop = Math.floor(candidateBBox.y);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const canvasX = candidateLeft + x;
      const canvasY = candidateTop + y;
      if (canvasX < 0 || canvasX >= canvas.width || canvasY < 0 || canvasY >= canvas.height) {
        continue;
      }
      const canvasIndex = canvasY * canvas.width + canvasX;
      const localX = canvasX - localLeft;
      const localY = canvasY - localTop;
      if (localX < 0 || localX >= local.width || localY < 0 || localY >= local.height) {
        continue;
      }
      const outputOffset = (y * width + x) * 4;
      const localOffset = (localY * local.width + localX) * 4;
      output.set(local.data.subarray(localOffset, localOffset + 4), outputOffset);
      if (repairMask[canvasIndex]! < MASK_FOREGROUND_ALPHA) continue;
      const canvasOffset = canvasIndex * 4;
      output[outputOffset] = repaired[canvasOffset]!;
      output[outputOffset + 1] = repaired[canvasOffset + 1]!;
      output[outputOffset + 2] = repaired[canvasOffset + 2]!;
    }
  }
  return { rgba: output, width, height };
}

export async function extractTextBacking(
  canvas: SourceCanvas,
  candidate: SemanticCandidate,
  texts: TextSlideElement[],
): Promise<TextBackingResult> {
  const association = resolveCarriedTexts(candidate, texts);
  const textNodeIds = association.carried.map(({ id }) => id);
  if (
    candidate.kind !== "text-backing" ||
    !association.valid ||
    canvas.rgba.length !== canvas.width * canvas.height * 4
  ) {
    return rejected(textNodeIds, "backing_mask_invalid");
  }
  if (
    candidate.bbox.x <= 0 ||
    candidate.bbox.y <= 0 ||
    candidate.bbox.x + candidate.bbox.width >= canvas.width ||
    candidate.bbox.y + candidate.bbox.height >= canvas.height
  ) {
    return rejected(textNodeIds, "backing_mask_invalid");
  }

  const proposals = await deriveSemanticMasks(canvas, candidate);
  const chosen = chooseSemanticMask(proposals, await emptyMask(canvas));
  if (chosen === undefined || chosen.metrics.completeness < 1) {
    return rejected(textNodeIds, "backing_mask_invalid");
  }
  const projected = await projectMask(chosen, canvas);
  const carriedIds = new Set(candidate.carriedTextIds);
  if (
    texts.some(
      (text) =>
        !carriedIds.has(text.id) &&
        bboxOverlapsBacking(text.bbox, projected.alpha, canvas),
    )
  ) {
    return rejected(textNodeIds, "backing_mask_invalid");
  }
  const source = await sharp(canvas.rgba, {
    raw: { width: canvas.width, height: canvas.height, channels: 4 },
  })
    .png()
    .toBuffer();

  const repairMasks: Buffer[] = [];
  const coreMasks: Buffer[] = [];
  try {
    for (const text of association.carried) {
      const [repairMask, coreMask] = await Promise.all([
        buildTightTextMask(source, text, {
          dilationPx: 1,
          surfaceMask: projected.encoded,
        }),
        buildTightTextMask(source, text, {
          dilationPx: 0,
          surfaceMask: projected.encoded,
        }),
      ]);
      repairMasks.push(repairMask.mask);
      coreMasks.push(coreMask.mask);
    }
  } catch {
    return rejected(textNodeIds, "surface_unstable");
  }
  const repairUnion = await unionMasks(repairMasks, canvas.width, canvas.height);
  const coreUnion = await unionMasks(coreMasks, canvas.width, canvas.height);
  for (let index = 0; index < repairUnion.pixels.length; index += 1) {
    if (projected.alpha[index]! < SURFACE_FOREGROUND_ALPHA) repairUnion.pixels[index] = 0;
    if (projected.alpha[index]! < SURFACE_FOREGROUND_ALPHA) coreUnion.pixels[index] = 0;
  }
  repairUnion.encoded = await encodeGreyscale(
    repairUnion.pixels,
    canvas.width,
    canvas.height,
  );

  const originalSurfaceResidual = surfaceResidualP95(
    canvas.rgba,
    projected.alpha,
    repairUnion.pixels,
    canvas.width,
    canvas.height,
  );
  if (originalSurfaceResidual > MAX_SURFACE_RESIDUAL_P95) {
    return rejected(textNodeIds, "surface_unstable");
  }

  const repaired = await repairLocalRegion(source, repairUnion.encoded, {
    surfaceMask: projected.encoded,
  });
  if (!repaired.accepted || repaired.metrics.outsideMaskChangedPixels !== 0) {
    return rejected(
      textNodeIds,
      repaired.reason === "surface_variance_too_high"
        ? "repair_seam"
        : "surface_unstable",
      {
        residualGlyphRatio: 0,
        outsideBackingChangedPixels: repaired.metrics.outsideMaskChangedPixels,
        seamContrastP95: repaired.metrics.filledPixelDistanceP95,
      },
    );
  }
  const repairedDecoded = await decodeRgba(repaired.image);
  const metrics = repairMetrics(
    canvas.rgba,
    repairedDecoded.data,
    projected.alpha,
    repairUnion.pixels,
    coreUnion.pixels,
    canvas.width,
    canvas.height,
  );
  if (metrics.residualGlyphRatio > MAX_RESIDUAL_GLYPH_RATIO) {
    return rejected(textNodeIds, "glyph_residue", metrics);
  }
  if (metrics.seamContrastP95 > MAX_SEAM_CONTRAST_P95) {
    return rejected(textNodeIds, "repair_seam", metrics);
  }
  const surfaceResidual = surfaceResidualP95(
    repairedDecoded.data,
    projected.alpha,
    repairUnion.pixels,
    canvas.width,
    canvas.height,
  );
  if (surfaceResidual > MAX_SURFACE_RESIDUAL_P95) {
    return rejected(textNodeIds, "surface_unstable", metrics);
  }

  const candidateAsset = buildCandidateAsset(
    projected.local,
    chosen.bbox,
    candidate.bbox,
    repairedDecoded.data,
    repairUnion.pixels,
    canvas,
  );
  const asset = await sharp(candidateAsset.rgba, {
    raw: {
      width: candidateAsset.width,
      height: candidateAsset.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
  return {
    accepted: true,
    asset,
    assetMask: projected.encoded,
    repairedSource: repaired.image,
    textNodeIds,
    metrics,
  };
}
