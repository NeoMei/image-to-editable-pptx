import sharp from "sharp";
import type {
  RecompositionOptions,
  RecompositionResult,
} from "../contracts.js";

const MAX_MEAN_ABSOLUTE_ERROR = 3;
const MAX_P95_CHANNEL_DELTA = 12;
const MAX_CHANGED_PIXEL_RATIO = 0.02;
const CHANGED_PIXEL_DELTA = 24;

export async function validateRecomposition(
  options: RecompositionOptions,
): Promise<RecompositionResult> {
  const sourceRaw = await sharp(options.source)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const backgroundRaw = await sharp(options.background)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    sourceRaw.info.width !== backgroundRaw.info.width ||
    sourceRaw.info.height !== backgroundRaw.info.height
  ) {
    throw new Error("Recomposition images must have equal dimensions");
  }
  const left = Math.floor(options.bbox.x);
  const top = Math.floor(options.bbox.y);
  const preview = await sharp(options.background)
    .composite([{ input: options.asset, left, top }])
    .png()
    .toBuffer();
  const previewRaw = await sharp(preview)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ignored = options.ignoredMask === undefined
    ? undefined
    : await sharp(options.ignoredMask)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
  if (
    ignored !== undefined &&
    (ignored.info.width !== sourceRaw.info.width ||
      ignored.info.height !== sourceRaw.info.height)
  ) {
    throw new Error("Ignored mask dimensions do not match source");
  }

  const width = sourceRaw.info.width;
  const height = sourceRaw.info.height;
  const startX = Math.max(0, left - 4);
  const startY = Math.max(0, top - 4);
  const endX = Math.min(width, Math.ceil(left + options.bbox.width + 4));
  const endY = Math.min(height, Math.ceil(top + options.bbox.height + 4));
  const maxDeltas: number[] = [];
  let totalChannelDelta = 0;
  let changedPixels = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const pixelIndex = y * width + x;
      if (
        ignored !== undefined &&
        ignored.data[pixelIndex * ignored.info.channels]! >= 128
      ) {
        continue;
      }
      const offset = pixelIndex * 3;
      const deltas = [0, 1, 2].map((channel) =>
        Math.abs(
          sourceRaw.data[offset + channel]! -
          previewRaw.data[offset + channel]!,
        ),
      );
      const maximum = Math.max(...deltas);
      totalChannelDelta += deltas[0]! + deltas[1]! + deltas[2]!;
      maxDeltas.push(maximum);
      if (maximum > CHANGED_PIXEL_DELTA) changedPixels += 1;
    }
  }
  if (maxDeltas.length === 0) {
    throw new Error("Recomposition comparison region is empty");
  }
  maxDeltas.sort((leftValue, rightValue) => leftValue - rightValue);
  const comparedPixels = maxDeltas.length;
  const metrics = {
    comparedPixels,
    meanAbsoluteError: totalChannelDelta / (comparedPixels * 3),
    p95ChannelDelta:
      maxDeltas[Math.min(maxDeltas.length - 1, Math.floor(maxDeltas.length * 0.95))]!,
    changedPixelRatio: changedPixels / comparedPixels,
  };
  const accepted =
    metrics.meanAbsoluteError <= MAX_MEAN_ABSOLUTE_ERROR &&
    metrics.p95ChannelDelta <= MAX_P95_CHANNEL_DELTA &&
    metrics.changedPixelRatio <= MAX_CHANGED_PIXEL_RATIO;
  return {
    accepted,
    preview,
    metrics,
    ...(accepted ? {} : { reason: "recomposition_mismatch" as const }),
  };
}
