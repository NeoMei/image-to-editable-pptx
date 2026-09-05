import type { CropRaster } from "./request.js";

export type AppearanceInput = {
  source: CropRaster;
  visible: Uint8Array;
  hidden: Uint8Array;
  occluder: Uint8Array;
  contacts: readonly number[];
};

export type AppearanceProfile = {
  rear: readonly [number, number, number];
  front: readonly [number, number, number];
  background: readonly [number, number, number];
};

export type QualityReason =
  | "insufficient_evidence"
  | "ambiguous_appearance"
  | "geometry"
  | "residual_occluder"
  | "seam_mismatch"
  | "contour_mismatch";

export type QualityMetrics = {
  rearSamples: number;
  frontSamples: number;
  backgroundSamples: number;
  generatedPixels: number;
  residualPixels: number;
  seamMaxDelta: number;
  returnedOutsideChangedPixels: number;
  returnedVisibleChangedPixels: number;
};

const MASK_SUPPORT_ALPHA = 16;
const OPAQUE_INTERIOR_ALPHA = 240;
const SAMPLE_RADIUS = 3;
const MIN_SAMPLES = 8;
const MAX_SOURCE_P95_DEVIATION = 6;
const MIN_PALETTE_SEPARATION = 36;
const MAX_CANDIDATE_DISTANCE = 12;
const MAX_SEAM_DELTA = 12;

type Color = readonly [number, number, number];
type ContactSide = "left" | "right" | "top" | "bottom";
type SourceAnalysis = {
  profile: AppearanceProfile;
  rearSamples: number;
  frontSamples: number;
  backgroundSamples: number;
};
type AppearanceSamples = {
  rear: Color[];
  front: Color[];
  background: Color[];
};

function geometryIsValid(input: AppearanceInput): boolean {
  const { width, height, rgba } = input.source;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return false;
  }
  const pixelCount = width * height;
  return (
    Number.isSafeInteger(pixelCount) &&
    rgba.length === pixelCount * 4 &&
    input.visible.length === pixelCount &&
    input.hidden.length === pixelCount &&
    input.occluder.length === pixelCount &&
    input.contacts.every(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < pixelCount,
    )
  );
}

function maskHasSupport(mask: Uint8Array, index: number): boolean {
  return mask[index]! >= MASK_SUPPORT_ALPHA;
}

function colorAt(rgba: Uint8Array, index: number): Color {
  const offset = index * 4;
  return [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!];
}

function alphaAt(rgba: Uint8Array, index: number): number {
  return rgba[index * 4 + 3]!;
}

function maximumChannelDistance(left: Color, right: Color): number {
  return Math.max(
    Math.abs(left[0] - right[0]),
    Math.abs(left[1] - right[1]),
    Math.abs(left[2] - right[2]),
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function medianColor(samples: readonly Color[]): Color {
  return [
    median(samples.map((sample) => sample[0])),
    median(samples.map((sample) => sample[1])),
    median(samples.map((sample) => sample[2])),
  ];
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function contactSides(
  index: number,
  hidden: Uint8Array,
  width: number,
  height: number,
): ContactSide[] {
  const x = index % width;
  const y = Math.floor(index / width);
  const sides: ContactSide[] = [];
  if (x + 1 < width && maskHasSupport(hidden, index + 1)) sides.push("left");
  if (x > 0 && maskHasSupport(hidden, index - 1)) sides.push("right");
  if (y + 1 < height && maskHasSupport(hidden, index + width)) sides.push("top");
  if (y > 0 && maskHasSupport(hidden, index - width)) sides.push("bottom");
  return sides;
}

function nearbyVisibleIndices(
  input: AppearanceInput,
  contacts: readonly number[],
): number[] {
  const { width, height, rgba } = input.source;
  const samples = new Set<number>();
  for (const contact of contacts) {
    const contactX = contact % width;
    const contactY = Math.floor(contact / width);
    for (let dy = -SAMPLE_RADIUS; dy <= SAMPLE_RADIUS; dy += 1) {
      for (let dx = -SAMPLE_RADIUS; dx <= SAMPLE_RADIUS; dx += 1) {
        const x = contactX + dx;
        const y = contactY + dy;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const index = y * width + x;
        if (
          maskHasSupport(input.visible, index) &&
          !maskHasSupport(input.hidden, index) &&
          !maskHasSupport(input.occluder, index) &&
          alphaAt(rgba, index) >= OPAQUE_INTERIOR_ALPHA
        ) {
          samples.add(index);
        }
      }
    }
  }
  return [...samples];
}

function collectRearIndices(
  input: AppearanceInput,
): number[] | undefined {
  const { width, height } = input.source;
  const contactsBySide: Record<ContactSide, number[]> = {
    left: [], right: [], top: [], bottom: [],
  };
  for (const contact of new Set(input.contacts)) {
    if (!maskHasSupport(input.visible, contact)) return undefined;
    for (const side of contactSides(contact, input.hidden, width, height)) {
      contactsBySide[side].push(contact);
    }
  }
  const horizontal = contactsBySide.left.length > 0 && contactsBySide.right.length > 0;
  const vertical = contactsBySide.top.length > 0 && contactsBySide.bottom.length > 0;
  if (!horizontal && !vertical) return undefined;
  const sides = horizontal
    ? (["left", "right"] as const)
    : (["top", "bottom"] as const);
  const result = new Set<number>();
  for (const side of sides) {
    const samples = nearbyVisibleIndices(input, contactsBySide[side]);
    if (samples.length < MIN_SAMPLES) return undefined;
    for (const index of samples) result.add(index);
  }
  return [...result];
}

function collectBackgroundIndices(input: AppearanceInput): number[] {
  const { width, height, rgba } = input.source;
  const indices = new Set<number>();
  for (let index = 0; index < input.hidden.length; index += 1) {
    if (!maskHasSupport(input.hidden, index)) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -SAMPLE_RADIUS; dy <= SAMPLE_RADIUS; dy += 1) {
      for (let dx = -SAMPLE_RADIUS; dx <= SAMPLE_RADIUS; dx += 1) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (
          !maskHasSupport(input.visible, next) &&
          !maskHasSupport(input.occluder, next) &&
          alphaAt(rgba, next) >= OPAQUE_INTERIOR_ALPHA
        ) indices.add(next);
      }
    }
  }
  return [...indices];
}

function collectSourceSamples(input: AppearanceInput): AppearanceSamples | undefined {
  const { rgba } = input.source;
  const rearIndices = collectRearIndices(input);
  if (rearIndices === undefined) return undefined;
  const frontIndices = Array.from(input.hidden.keys()).filter((index) =>
    maskHasSupport(input.hidden, index) &&
    maskHasSupport(input.occluder, index) &&
    alphaAt(rgba, index) >= OPAQUE_INTERIOR_ALPHA);
  const backgroundIndices = collectBackgroundIndices(input);
  if (
    rearIndices.length < MIN_SAMPLES ||
    frontIndices.length < MIN_SAMPLES ||
    backgroundIndices.length < MIN_SAMPLES
  ) return undefined;
  const colors = (indices: readonly number[]): Color[] =>
    indices.map((index) => colorAt(rgba, index));
  return {
    rear: colors(rearIndices),
    front: colors(frontIndices),
    background: colors(backgroundIndices),
  };
}

function sourceSamples(input: AppearanceInput):
  | { ok: true; value: SourceAnalysis }
  | { ok: false; reason: QualityReason } {
  const samples = collectSourceSamples(input);
  if (samples === undefined) return { ok: false, reason: "insufficient_evidence" };
  const profile: AppearanceProfile = {
    rear: medianColor(samples.rear),
    front: medianColor(samples.front),
    background: medianColor(samples.background),
  };

  for (const [appearanceSamples, appearance] of [
    [samples.rear, profile.rear],
    [samples.front, profile.front],
    [samples.background, profile.background],
  ] as const) {
    const deviations = appearanceSamples.map((sample) =>
      maximumChannelDistance(sample, appearance));
    if (percentile95(deviations) > MAX_SOURCE_P95_DEVIATION) {
      return { ok: false, reason: "ambiguous_appearance" };
    }
  }
  if (
    maximumChannelDistance(profile.rear, profile.front) < MIN_PALETTE_SEPARATION ||
    maximumChannelDistance(profile.rear, profile.background) < MIN_PALETTE_SEPARATION ||
    maximumChannelDistance(profile.front, profile.background) < MIN_PALETTE_SEPARATION
  ) {
    return { ok: false, reason: "ambiguous_appearance" };
  }

  return {
    ok: true,
    value: {
      profile,
      rearSamples: samples.rear.length,
      frontSamples: samples.front.length,
      backgroundSamples: samples.background.length,
    },
  };
}

export function qualifyAppearance(input: AppearanceInput):
  | { ok: true; profile: AppearanceProfile }
  | { ok: false; reason: QualityReason } {
  if (!geometryIsValid(input)) return { ok: false, reason: "geometry" };
  const analysis = sourceSamples(input);
  return analysis.ok
    ? { ok: true, profile: analysis.value.profile }
    : analysis;
}

function emptyMetrics(): QualityMetrics {
  return {
    rearSamples: 0,
    frontSamples: 0,
    backgroundSamples: 0,
    generatedPixels: 0,
    residualPixels: 0,
    seamMaxDelta: 0,
    returnedOutsideChangedPixels: 0,
    returnedVisibleChangedPixels: 0,
  };
}

function pixelsDiffer(left: Uint8Array, right: Uint8Array, index: number): boolean {
  const offset = index * 4;
  return (
    left[offset] !== right[offset] ||
    left[offset + 1] !== right[offset + 1] ||
    left[offset + 2] !== right[offset + 2] ||
    left[offset + 3] !== right[offset + 3]
  );
}

function neighbors(index: number, width: number, height: number): number[] {
  const x = index % width;
  const y = Math.floor(index / width);
  const result: number[] = [];
  if (x > 0) result.push(index - 1);
  if (x + 1 < width) result.push(index + 1);
  if (y > 0) result.push(index - width);
  if (y + 1 < height) result.push(index + width);
  return result;
}

function connectedNeighbors(index: number, width: number, height: number): number[] {
  const x = index % width;
  const y = Math.floor(index / width);
  const result: number[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const nextX = x + dx;
      const nextY = y + dy;
      if (nextX >= 0 && nextX < width && nextY >= 0 && nextY < height) {
        result.push(nextY * width + nextX);
      }
    }
  }
  return result;
}

function isOneComponent(mask: Uint8Array, width: number, height: number): boolean {
  const first = mask.findIndex((value) => value !== 0);
  if (first < 0) return false;
  const visited = new Uint8Array(mask.length);
  const queue = [first];
  visited[first] = 1;
  let count = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!;
    count += 1;
    for (const next of connectedNeighbors(index, width, height)) {
      if (mask[next] === 0 || visited[next] !== 0) continue;
      visited[next] = 1;
      queue.push(next);
    }
  }
  return count === mask.reduce((total, value) => total + (value !== 0 ? 1 : 0), 0);
}

export function assessHiddenCandidate(input: AppearanceInput & {
  returned: CropRaster;
  profile: AppearanceProfile;
}):
  | { ok: true; generated: Uint8Array; metrics: QualityMetrics }
  | { ok: false; reason: QualityReason; metrics: QualityMetrics } {
  let metrics = emptyMetrics();
  if (
    !geometryIsValid(input) ||
    input.returned.width !== input.source.width ||
    input.returned.height !== input.source.height ||
    input.returned.rgba.length !== input.source.rgba.length
  ) {
    return { ok: false, reason: "geometry", metrics };
  }
  const source = sourceSamples(input);
  if (!source.ok) return { ok: false, reason: source.reason, metrics };
  metrics = {
    ...metrics,
    rearSamples: source.value.rearSamples,
    frontSamples: source.value.frontSamples,
    backgroundSamples: source.value.backgroundSamples,
  };

  const generated = new Uint8Array(input.hidden.length);
  let unknownPixels = 0;
  let fringePixels = 0;
  for (let index = 0; index < input.hidden.length; index += 1) {
    if (pixelsDiffer(input.source.rgba, input.returned.rgba, index)) {
      if (!maskHasSupport(input.hidden, index)) metrics.returnedOutsideChangedPixels += 1;
      if (maskHasSupport(input.visible, index)) metrics.returnedVisibleChangedPixels += 1;
    }
    if (!maskHasSupport(input.hidden, index)) continue;
    const alpha = alphaAt(input.returned.rgba, index);
    if (alpha < MASK_SUPPORT_ALPHA) continue;
    if (alpha < OPAQUE_INTERIOR_ALPHA) {
      fringePixels += 1;
      continue;
    }
    const color = colorAt(input.returned.rgba, index);
    const distances = [
      { kind: "rear", distance: maximumChannelDistance(color, input.profile.rear) },
      { kind: "front", distance: maximumChannelDistance(color, input.profile.front) },
      { kind: "background", distance: maximumChannelDistance(color, input.profile.background) },
    ] as const;
    const matches = distances.filter(({ distance }) => distance <= MAX_CANDIDATE_DISTANCE);
    const bestDistance = Math.min(...matches.map(({ distance }) => distance));
    const best = matches.filter(({ distance }) => distance === bestDistance);
    if (best.length !== 1) {
      unknownPixels += 1;
    } else if (best[0]!.kind === "rear") {
      generated[index] = 255;
      metrics.generatedPixels += 1;
    } else if (best[0]!.kind === "front") {
      metrics.residualPixels += 1;
    }
  }

  if (metrics.residualPixels > 0) {
    return { ok: false, reason: "residual_occluder", metrics };
  }
  if (unknownPixels > 0 || fringePixels > 0) {
    return { ok: false, reason: "ambiguous_appearance", metrics };
  }

  let seamMaxDelta = 0;
  for (const contact of new Set(input.contacts)) {
    const generatedNeighbors = neighbors(
      contact,
      input.source.width,
      input.source.height,
    ).filter((index) => generated[index] !== 0);
    if (generatedNeighbors.length === 0) {
      return { ok: false, reason: "contour_mismatch", metrics };
    }
    for (const generatedNeighbor of generatedNeighbors) {
      if (alphaAt(input.returned.rgba, generatedNeighbor) < OPAQUE_INTERIOR_ALPHA) {
        return { ok: false, reason: "ambiguous_appearance", metrics };
      }
      seamMaxDelta = Math.max(
        seamMaxDelta,
        maximumChannelDistance(
          colorAt(input.source.rgba, contact),
          colorAt(input.returned.rgba, generatedNeighbor),
        ),
      );
    }
  }
  metrics.seamMaxDelta = seamMaxDelta;
  if (seamMaxDelta > MAX_SEAM_DELTA) {
    return { ok: false, reason: "seam_mismatch", metrics };
  }

  const combined = Uint8Array.from(input.visible, (value, index) =>
    maskHasSupport(input.visible, index) || generated[index] !== 0 ? 255 : 0,
  );
  if (!isOneComponent(generated, input.source.width, input.source.height) ||
      !isOneComponent(combined, input.source.width, input.source.height)) {
    return { ok: false, reason: "contour_mismatch", metrics };
  }
  return { ok: true, generated, metrics };
}
