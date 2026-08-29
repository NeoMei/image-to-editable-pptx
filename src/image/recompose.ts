import sharp from "sharp";
import type {
  RecompositionOptions,
  RecompositionResult,
  WholePageRecompositionOptions,
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

export async function validateWholePageRecomposition(
  options: WholePageRecompositionOptions,
): Promise<RecompositionResult> {
  const orderedLayers = [...options.layers].sort(
    (left, right) =>
      left.zIndex - right.zIndex || compareCodePoints(left.id, right.id),
  );
  const [sourceRaw, backgroundRaw, ignored, decodedLayers] = await Promise.all([
    sharp(options.source).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(options.background).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    options.ignoredMask === undefined
      ? Promise.resolve(undefined)
      : sharp(options.ignoredMask)
          .removeAlpha()
          .greyscale()
          .raw()
          .toBuffer({ resolveWithObject: true }),
    Promise.all(
      orderedLayers.map(async (layer) => {
        const decoded = await sharp(layer.asset)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (
          decoded.info.width !== Math.ceil(layer.bbox.width) ||
          decoded.info.height !== Math.ceil(layer.bbox.height)
        ) {
          throw new Error(`Recomposition layer dimensions do not match bbox: ${layer.id}`);
        }
        return { layer, decoded };
      }),
    ),
  ]);
  if (
    sourceRaw.info.width !== backgroundRaw.info.width ||
    sourceRaw.info.height !== backgroundRaw.info.height
  ) {
    throw new Error("Recomposition images must have equal dimensions");
  }
  if (
    ignored !== undefined &&
    (ignored.info.width !== sourceRaw.info.width ||
      ignored.info.height !== sourceRaw.info.height)
  ) {
    throw new Error("Ignored mask dimensions do not match source");
  }

  const preview = await sharp(options.background)
    .composite(
      orderedLayers.map(({ asset, bbox }) => ({
        input: asset,
        left: Math.floor(bbox.x),
        top: Math.floor(bbox.y),
      })),
    )
    .png()
    .toBuffer();
  const previewRaw = await sharp(preview)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = sourceRaw.info.width;
  const height = sourceRaw.info.height;
  const maxDeltas: number[] = [];
  const changedPixelIndexes: number[] = [];
  let totalChannelDelta = 0;
  for (let index = 0; index < width * height; index += 1) {
    if (ignored !== undefined && ignored.data[index * ignored.info.channels]! >= 128) {
      continue;
    }
    const offset = index * 4;
    const deltas = [0, 1, 2].map((channel) =>
      Math.abs(sourceRaw.data[offset + channel]! - previewRaw.data[offset + channel]!),
    );
    const maximum = Math.max(...deltas);
    totalChannelDelta += deltas[0]! + deltas[1]! + deltas[2]!;
    maxDeltas.push(maximum);
    if (maximum > CHANGED_PIXEL_DELTA) changedPixelIndexes.push(index);
  }
  maxDeltas.sort((left, right) => left - right);
  const comparedPixels = maxDeltas.length;
  const metrics = {
    comparedPixels,
    meanAbsoluteError:
      comparedPixels === 0 ? 0 : totalChannelDelta / (comparedPixels * 3),
    p95ChannelDelta:
      comparedPixels === 0
        ? 0
        : maxDeltas[
            Math.min(maxDeltas.length - 1, Math.floor(maxDeltas.length * 0.95))
          ]!,
    changedPixelRatio:
      comparedPixels === 0 ? 0 : changedPixelIndexes.length / comparedPixels,
  };
  const accepted =
    metrics.meanAbsoluteError <= MAX_MEAN_ABSOLUTE_ERROR &&
    metrics.p95ChannelDelta <= MAX_P95_CHANNEL_DELTA &&
    changedPixelIndexes.length === 0;
  if (accepted) return { accepted: true, preview, metrics };

  const affected = new Set<string>();
  let ambiguous = false;
  for (const pixelIndex of changedPixelIndexes) {
    const canvasX = pixelIndex % width;
    const canvasY = Math.floor(pixelIndex / width);
    const owners: string[] = [];
    for (let index = decodedLayers.length - 1; index >= 0; index -= 1) {
      const { layer, decoded } = decodedLayers[index]!;
      const localX = canvasX - Math.floor(layer.bbox.x);
      const localY = canvasY - Math.floor(layer.bbox.y);
      if (
        localX < 0 ||
        localX >= decoded.info.width ||
        localY < 0 ||
        localY >= decoded.info.height
      ) {
        continue;
      }
      const alpha = decoded.data[
        (localY * decoded.info.width + localX) * decoded.info.channels + 3
      ]!;
      if (alpha === 0) continue;
      owners.push(layer.id);
      if (alpha >= 254) break;
    }
    if (owners.length !== 1) {
      ambiguous = true;
      break;
    }
    affected.add(owners[0]!);
  }
  if (changedPixelIndexes.length === 0 || affected.size === 0) ambiguous = true;
  return {
    accepted: false,
    preview,
    metrics,
    reason: "recomposition_mismatch",
    attribution: ambiguous ? "ambiguous" : "deterministic",
    affectedLayerIds: ambiguous ? [] : [...affected].sort(compareCodePoints),
  };
}
