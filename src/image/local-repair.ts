import sharp from "sharp";

import type {
  LocalRepairMetrics,
  LocalRepairReason,
  LocalRepairResult,
} from "../contracts.js";

const MIN_RING_SAMPLES = 16;
const MAX_RING_CHANNEL_MAD = 18;
const MAX_FILLED_PIXEL_DISTANCE_P95 = 28;

const DIRECTIONS = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
] as const;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function rejected(
  source: Buffer,
  reason: LocalRepairReason,
  metrics: LocalRepairMetrics,
): LocalRepairResult {
  return { image: source, accepted: false, metrics, reason };
}

function neighbors(index: number, width: number, height: number): number[] {
  const x = index % width;
  const y = Math.floor(index / width);
  const result: number[] = [];
  for (const [dx, dy] of DIRECTIONS) {
    const nextX = x + dx;
    const nextY = y + dy;
    if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
      continue;
    }
    result.push(nextY * width + nextX);
  }
  return result;
}

export async function repairLocalRegion(
  source: Buffer,
  mask: Buffer,
): Promise<LocalRepairResult> {
  const [sourceDecoded, maskDecoded] = await Promise.all([
    sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(mask)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height } = sourceDecoded.info;
  if (
    maskDecoded.info.width !== width ||
    maskDecoded.info.height !== height
  ) {
    throw new RangeError("Source and mask dimensions must match");
  }

  const pixelCount = width * height;
  const masked = new Uint8Array(pixelCount);
  const maskedIndexes: number[] = [];
  for (let index = 0; index < pixelCount; index += 1) {
    if (maskDecoded.data[index]! < 128) continue;
    masked[index] = 1;
    maskedIndexes.push(index);
  }

  const metrics: LocalRepairMetrics = {
    maskedPixels: maskedIndexes.length,
    outsideMaskChangedPixels: 0,
    ringSamples: 0,
    ringChannelMad: 0,
    filledPixelDistanceP95: 0,
  };
  if (maskedIndexes.length === 0) {
    return rejected(source, "mask_empty", metrics);
  }

  const ringSeen = new Uint8Array(pixelCount);
  for (const index of maskedIndexes) ringSeen[index] = 1;
  let frontier = maskedIndexes;
  const ring: number[] = [];
  while (ring.length < MIN_RING_SAMPLES && frontier.length > 0) {
    const nextFrontier: number[] = [];
    for (const index of frontier) {
      for (const neighbor of neighbors(index, width, height)) {
        if (ringSeen[neighbor] !== 0) continue;
        ringSeen[neighbor] = 1;
        if (masked[neighbor] !== 0) continue;
        ring.push(neighbor);
        nextFrontier.push(neighbor);
      }
    }
    frontier = nextFrontier;
  }
  metrics.ringSamples = ring.length;
  if (ring.length < MIN_RING_SAMPLES) {
    return rejected(source, "surface_samples_insufficient", metrics);
  }

  const channelValues = [[], [], []] as [number[], number[], number[]];
  for (const index of ring) {
    const offset = index * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      channelValues[channel]!.push(sourceDecoded.data[offset + channel]!);
    }
  }
  const ringMedian = channelValues.map((values) => median(values));
  metrics.ringChannelMad = Math.max(
    ...channelValues.map((values, channel) =>
      median(values.map((value) => Math.abs(value - ringMedian[channel]!))),
    ),
  );
  if (metrics.ringChannelMad > MAX_RING_CHANNEL_MAD) {
    return rejected(source, "surface_variance_too_high", metrics);
  }

  const nearestSeed = new Int32Array(pixelCount);
  nearestSeed.fill(-1);
  const queue = new Int32Array(pixelCount);
  let queueHead = 0;
  let queueTail = 0;
  for (const index of ring) {
    nearestSeed[index] = index;
    queue[queueTail] = index;
    queueTail += 1;
  }
  while (queueHead < queueTail) {
    const index = queue[queueHead]!;
    queueHead += 1;
    for (const neighbor of neighbors(index, width, height)) {
      if (masked[neighbor] === 0 || nearestSeed[neighbor] !== -1) continue;
      nearestSeed[neighbor] = nearestSeed[index]!;
      queue[queueTail] = neighbor;
      queueTail += 1;
    }
  }

  const output = Buffer.from(sourceDecoded.data);
  const filledDistances: number[] = [];
  for (const index of maskedIndexes) {
    const seed = nearestSeed[index]!;
    if (seed < 0) {
      return rejected(source, "surface_samples_insufficient", metrics);
    }
    const outputOffset = index * 4;
    const seedOffset = seed * 4;
    let distance = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = sourceDecoded.data[seedOffset + channel]!;
      output[outputOffset + channel] = value;
      distance = Math.max(distance, Math.abs(value - ringMedian[channel]!));
    }
    filledDistances.push(distance);
  }

  for (let index = 0; index < pixelCount; index += 1) {
    if (masked[index] !== 0) continue;
    const offset = index * 4;
    if (
      output[offset] !== sourceDecoded.data[offset] ||
      output[offset + 1] !== sourceDecoded.data[offset + 1] ||
      output[offset + 2] !== sourceDecoded.data[offset + 2] ||
      output[offset + 3] !== sourceDecoded.data[offset + 3]
    ) {
      metrics.outsideMaskChangedPixels += 1;
    }
  }

  metrics.filledPixelDistanceP95 = percentile95(filledDistances);
  if (metrics.filledPixelDistanceP95 > MAX_FILLED_PIXEL_DISTANCE_P95) {
    return rejected(source, "filled_pixels_too_different", metrics);
  }

  const image = await sharp(output, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
  return { image, accepted: true, metrics };
}
