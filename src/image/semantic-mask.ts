import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import sharp from "sharp";

import type { BBox } from "../contracts.js";
import type { SemanticCandidate } from "../scene/plan.js";
import { removeBackgroundFromRgba } from "./extract.js";
import type { SourceCanvas } from "./source.js";

const MAX_OPAQUE_BORDER_RATIO = 0.02;
const MIN_FOREGROUND_RATIO = 0.01;
const MAX_FOREGROUND_RATIO = 0.95;
const FOREGROUND_ALPHA = 16;

export type MaskCandidate = {
  bbox: BBox;
  mask: Buffer;
  cropPaddingPx: number;
  metrics: {
    foregroundRatio: number;
    opaqueBorderRatio: number;
    antialiasedEdgeRatio: number;
    connectedComponents: number;
    completeness: number;
  };
};

type IntegerBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type DecodedMask = {
  width: number;
  height: number;
  alpha: Uint8Array;
};

function integerBounds(bbox: BBox, width: number, height: number): IntegerBounds {
  if (
    !Number.isFinite(bbox.x) ||
    !Number.isFinite(bbox.y) ||
    !Number.isFinite(bbox.width) ||
    !Number.isFinite(bbox.height) ||
    bbox.width <= 0 ||
    bbox.height <= 0
  ) {
    throw new RangeError("Semantic candidate bbox must be finite and non-empty");
  }
  const left = Math.max(0, Math.floor(bbox.x));
  const top = Math.max(0, Math.floor(bbox.y));
  const right = Math.min(width, Math.ceil(bbox.x + bbox.width));
  const bottom = Math.min(height, Math.ceil(bbox.y + bbox.height));
  if (right <= left || bottom <= top) {
    throw new RangeError("Semantic candidate bbox does not intersect the source canvas");
  }
  return { left, top, right, bottom };
}

function paddingSchedule(
  canvas: SourceCanvas,
  candidateBounds: IntegerBounds,
): number[] {
  const shorterCanvasSide = Math.min(canvas.width, canvas.height);
  const shorterCandidateSide = Math.min(
    candidateBounds.right - candidateBounds.left,
    candidateBounds.bottom - candidateBounds.top,
  );
  const step = Math.max(1, Math.round(shorterCanvasSide / 64));
  const candidateLimit = Math.max(1, Math.floor(shorterCandidateSide / 4));
  const maximum = Math.max(step, Math.min(step * 2, candidateLimit));
  return [...new Set([0, step, maximum])].sort((left, right) => left - right);
}

function expandBounds(
  bounds: IntegerBounds,
  padding: number,
  canvas: SourceCanvas,
): IntegerBounds {
  return {
    left: Math.max(0, bounds.left - padding),
    top: Math.max(0, bounds.top - padding),
    right: Math.min(canvas.width, bounds.right + padding),
    bottom: Math.min(canvas.height, bounds.bottom + padding),
  };
}

function cropCanonicalRgba(canvas: SourceCanvas, bounds: IntegerBounds): Buffer {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const crop = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = ((bounds.top + y) * canvas.width + bounds.left) * 4;
    canvas.rgba.copy(crop, y * width * 4, sourceOffset, sourceOffset + width * 4);
  }
  return crop;
}

function confineToCandidate(
  rgba: Buffer,
  crop: IntegerBounds,
  candidate: IntegerBounds,
): void {
  const width = crop.right - crop.left;
  const height = crop.bottom - crop.top;
  for (let y = 0; y < height; y += 1) {
    const canvasY = crop.top + y;
    for (let x = 0; x < width; x += 1) {
      const canvasX = crop.left + x;
      if (
        canvasX < candidate.left ||
        canvasX >= candidate.right ||
        canvasY < candidate.top ||
        canvasY >= candidate.bottom
      ) {
        rgba[(y * width + x) * 4 + 3] = 0;
      }
    }
  }
}

function connectedComponents(alpha: Uint8Array, width: number, height: number): number {
  const visited = new Uint8Array(alpha.length);
  const queue = new Int32Array(alpha.length);
  let components = 0;
  for (let start = 0; start < alpha.length; start += 1) {
    if (alpha[start]! < FOREGROUND_ALPHA || visited[start] === 1) continue;
    components += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++]!;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (visited[next] === 1 || alpha[next]! < FOREGROUND_ALPHA) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
  }
  return components;
}

function foregroundComponents(
  rgba: Buffer,
  width: number,
  height: number,
): number[][] {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components: number[][] = [];
  for (let start = 0; start < visited.length; start += 1) {
    if (rgba[start * 4 + 3]! < FOREGROUND_ALPHA || visited[start] === 1) continue;
    const component: number[] = [];
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++]!;
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          const nextY = y + offsetY;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (visited[next] === 1 || rgba[next * 4 + 3]! < FOREGROUND_ALPHA) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    components.push(component);
  }
  return components.sort((left, right) => right.length - left.length);
}

function connectedComponentVariants(
  rgba: Buffer,
  width: number,
  height: number,
  kind: SemanticCandidate["kind"],
): Array<{ rgba: Buffer; retainedRatio: number }> {
  const variants = [{ rgba, retainedRatio: 1 }];
  if (kind !== "foreground-object") return variants;
  const components = foregroundComponents(rgba, width, height);
  if (components.length <= 1) return variants;
  const foregroundPixels = components.reduce(
    (total, component) => total + component.length,
    0,
  );
  const dominant = components[0]!;
  const retainedRatio = dominant.length / foregroundPixels;
  if (retainedRatio < 0.5 || retainedRatio >= 0.995) return variants;

  const keep = new Uint8Array(width * height);
  for (const index of dominant) keep[index] = 1;
  const isolated = Buffer.from(rgba);
  for (let index = 0; index < keep.length; index += 1) {
    if (keep[index] === 0) isolated[index * 4 + 3] = 0;
  }
  variants.push({ rgba: isolated, retainedRatio });
  return variants;
}

function maskMetrics(
  rgba: Buffer,
  width: number,
  height: number,
): MaskCandidate["metrics"] {
  const alpha = new Uint8Array(width * height);
  let foregroundPixels = 0;
  let antialiasedPixels = 0;
  let opaqueBorderPixels = 0;
  let perimeterPixels = 0;
  const touchedSides = new Set<number>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = rgba[(y * width + x) * 4 + 3]!;
      const index = y * width + x;
      alpha[index] = value;
      if (value >= FOREGROUND_ALPHA) foregroundPixels += 1;
      if (value > 0 && value < 255) antialiasedPixels += 1;
      const border = x === 0 || x === width - 1 || y === 0 || y === height - 1;
      if (border) {
        perimeterPixels += 1;
        if (value >= 128) opaqueBorderPixels += 1;
        if (value >= FOREGROUND_ALPHA) {
          if (x === 0) touchedSides.add(0);
          if (x === width - 1) touchedSides.add(1);
          if (y === 0) touchedSides.add(2);
          if (y === height - 1) touchedSides.add(3);
        }
      }
    }
  }
  return {
    foregroundRatio: foregroundPixels / (width * height),
    opaqueBorderRatio: perimeterPixels === 0 ? 1 : opaqueBorderPixels / perimeterPixels,
    antialiasedEdgeRatio:
      foregroundPixels === 0 ? 0 : antialiasedPixels / foregroundPixels,
    connectedComponents: connectedComponents(alpha, width, height),
    completeness: 1 - touchedSides.size / 4,
  };
}

function isAcceptable(metrics: MaskCandidate["metrics"]): boolean {
  return (
    metrics.foregroundRatio >= MIN_FOREGROUND_RATIO &&
    metrics.foregroundRatio <= MAX_FOREGROUND_RATIO &&
    metrics.opaqueBorderRatio <= MAX_OPAQUE_BORDER_RATIO &&
    metrics.connectedComponents > 0 &&
    metrics.completeness >= 0.5
  );
}

function proposalTolerances(format: SourceCanvas["format"]): readonly number[] {
  return format === "jpeg" ? [32, 40] : [24, 32];
}

export async function deriveSemanticMasks(
  canvas: SourceCanvas,
  candidate: SemanticCandidate,
): Promise<MaskCandidate[]> {
  if (canvas.rgba.length !== canvas.width * canvas.height * 4) {
    throw new Error("Canonical RGBA buffer length does not match the source canvas");
  }
  const candidateBounds = integerBounds(candidate.bbox, canvas.width, canvas.height);
  const masks: MaskCandidate[] = [];
  const seen = new Set<string>();
  for (const cropPaddingPx of paddingSchedule(canvas, candidateBounds)) {
    const crop = expandBounds(candidateBounds, cropPaddingPx, canvas);
    const width = crop.right - crop.left;
    const height = crop.bottom - crop.top;
    const sourceCrop = cropCanonicalRgba(canvas, crop);
    for (const tolerance of proposalTolerances(canvas.format)) {
      const proposal = removeBackgroundFromRgba(sourceCrop, width, height, tolerance, {
        removeInteriorMatches: true,
        minimumEdgeColorConsistency: 0.6,
      });
      if (proposal === undefined) continue;
      confineToCandidate(proposal.rgba, crop, candidateBounds);
      const completeMetrics = maskMetrics(proposal.rgba, width, height);
      if (completeMetrics.completeness !== 1) continue;
      for (const variant of connectedComponentVariants(
        proposal.rgba,
        width,
        height,
        candidate.kind,
      )) {
        const measured = maskMetrics(variant.rgba, width, height);
        const metrics = {
          ...measured,
          completeness: measured.completeness * variant.retainedRatio,
        };
        if (!isAcceptable(metrics)) continue;
        const mask = await sharp(variant.rgba, {
          raw: { width, height, channels: 4 },
        })
          .png()
          .toBuffer();
        const digest = createHash("sha256").update(mask).digest("hex");
        const key = `${crop.left}:${crop.top}:${width}:${height}:${digest}`;
        if (seen.has(key)) continue;
        seen.add(key);
        masks.push({
          bbox: { x: crop.left, y: crop.top, width, height },
          mask,
          cropPaddingPx,
          metrics,
        });
      }
    }
  }
  return masks.sort(
    (left, right) =>
      left.cropPaddingPx - right.cropPaddingPx ||
      left.bbox.x - right.bbox.x ||
      left.bbox.y - right.bbox.y,
  );
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) return left;
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

function decodePngMask(input: Buffer): DecodedMask | undefined {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (input.length < signature.length || !input.subarray(0, 8).equals(signature)) {
    return undefined;
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset + 12 <= input.length; ) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > input.length) return undefined;
    if (type === "IHDR") {
      width = input.readUInt32BE(dataStart);
      height = input.readUInt32BE(dataStart + 4);
      bitDepth = input[dataStart + 8]!;
      colorType = input[dataStart + 9]!;
      interlace = input[dataStart + 12]!;
    } else if (type === "IDAT") {
      compressed.push(input.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  const channels = new Map([
    [0, 1],
    [2, 3],
    [4, 2],
    [6, 4],
  ]).get(colorType);
  if (
    width <= 0 ||
    height <= 0 ||
    bitDepth !== 8 ||
    channels === undefined ||
    interlace !== 0 ||
    compressed.length === 0
  ) {
    return undefined;
  }
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(compressed));
  } catch {
    return undefined;
  }
  const rowBytes = width * channels;
  if (filtered.length !== (rowBytes + 1) * height) return undefined;
  const pixels = new Uint8Array(rowBytes * height);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[inputOffset++]!;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = filtered[inputOffset++]!;
      const index = y * rowBytes + x;
      const left = x >= channels ? pixels[index - channels]! : 0;
      const above = y > 0 ? pixels[index - rowBytes]! : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[index - rowBytes - channels]! : 0;
      let reconstructed: number;
      if (filter === 0) reconstructed = raw;
      else if (filter === 1) reconstructed = raw + left;
      else if (filter === 2) reconstructed = raw + above;
      else if (filter === 3) reconstructed = raw + Math.floor((left + above) / 2);
      else if (filter === 4) reconstructed = raw + paeth(left, above, upperLeft);
      else return undefined;
      pixels[index] = reconstructed & 0xff;
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    const offset = index * channels;
    if (colorType === 0) alpha[index] = pixels[offset]!;
    else if (colorType === 4) alpha[index] = pixels[offset + 1]!;
    else if (colorType === 6) alpha[index] = pixels[offset + 3]!;
    else alpha[index] = Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!);
  }
  return { width, height, alpha };
}

function unrelatedTextOverlap(
  mask: MaskCandidate,
  decodedMask: DecodedMask,
  text: DecodedMask,
): number {
  const localText = text.width === decodedMask.width && text.height === decodedMask.height;
  let overlap = 0;
  for (let y = 0; y < decodedMask.height; y += 1) {
    for (let x = 0; x < decodedMask.width; x += 1) {
      const index = y * decodedMask.width + x;
      if (decodedMask.alpha[index]! < FOREGROUND_ALPHA) continue;
      const textX = localText ? x : Math.floor(mask.bbox.x) + x;
      const textY = localText ? y : Math.floor(mask.bbox.y) + y;
      if (textX < 0 || textX >= text.width || textY < 0 || textY >= text.height) continue;
      if (text.alpha[textY * text.width + textX]! >= FOREGROUND_ALPHA) overlap += 1;
    }
  }
  return overlap;
}

function decodedOpaqueBorderRatio(mask: DecodedMask): number {
  let opaque = 0;
  let perimeter = 0;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (x !== 0 && x !== mask.width - 1 && y !== 0 && y !== mask.height - 1) {
        continue;
      }
      perimeter += 1;
      if (mask.alpha[y * mask.width + x]! >= 128) opaque += 1;
    }
  }
  return perimeter === 0 ? 1 : opaque / perimeter;
}

export function chooseSemanticMask(
  masks: MaskCandidate[],
  unrelatedTextMask: Buffer,
): MaskCandidate | undefined {
  const text = decodePngMask(unrelatedTextMask);
  if (text === undefined) return undefined;
  const eligible = masks.flatMap((mask) => {
    if (
      mask.metrics.opaqueBorderRatio > MAX_OPAQUE_BORDER_RATIO ||
      mask.metrics.foregroundRatio < MIN_FOREGROUND_RATIO ||
      mask.metrics.foregroundRatio > MAX_FOREGROUND_RATIO ||
      mask.metrics.connectedComponents <= 0 ||
      mask.metrics.completeness <= 0
    ) {
      return [];
    }
    const decoded = decodePngMask(mask.mask);
    if (
      decoded === undefined ||
      decoded.width !== Math.ceil(mask.bbox.width) ||
      decoded.height !== Math.ceil(mask.bbox.height) ||
      decodedOpaqueBorderRatio(decoded) > MAX_OPAQUE_BORDER_RATIO
    ) {
      return [];
    }
    const overlap = unrelatedTextOverlap(mask, decoded, text);
    if (overlap > 0) return [];
    return [{ mask, overlap }];
  });
  eligible.sort(
    (left, right) =>
      right.mask.metrics.completeness - left.mask.metrics.completeness ||
      left.overlap - right.overlap ||
      left.mask.metrics.opaqueBorderRatio - right.mask.metrics.opaqueBorderRatio ||
      right.mask.metrics.foregroundRatio - left.mask.metrics.foregroundRatio ||
      left.mask.bbox.width * left.mask.bbox.height -
        right.mask.bbox.width * right.mask.bbox.height ||
      left.mask.cropPaddingPx - right.mask.cropPaddingPx,
  );
  return eligible[0]?.mask;
}
