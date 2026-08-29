import sharp from "sharp";

import type { BBox } from "../contracts.js";

const DEFAULT_COLOR_TOLERANCE = 24;
const MIN_EDGE_COLOR_CONSISTENCY = 0.85;
const MIN_TRANSPARENT_RATIO = 0.05;
const MAX_TRANSPARENT_RATIO = 0.92;
const MAX_OPAQUE_BORDER_RATIO = 0.02;
const SOFT_ALPHA_COLOR_RANGE = 96;

export type AssetExtraction = "transparent" | "rectangular";

export type ExtractAssetOptions = {
  extraction?: AssetExtraction;
  colorTolerance?: number;
};

export type ExtractedAsset = {
  image: Buffer;
  extraction: AssetExtraction;
  metrics: {
    transparentRatio: number;
    opaqueBorderRatio: number;
    foregroundPixels: number;
  };
  fallbackReason?:
    | "edge_colors_inconsistent"
    | "transparent_pixel_ratio_below_5_percent"
    | "transparent_pixel_ratio_above_92_percent"
    | "opaque_border_ratio_above_2_percent";
};

type AlphaMetrics = ExtractedAsset["metrics"];
type FallbackReason = NonNullable<ExtractedAsset["fallbackReason"]>;

type Rgb = readonly [number, number, number];

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  const upper = values[middle]!;
  return values.length % 2 === 0 ? (values[middle - 1]! + upper) / 2 : upper;
}

function edgeColors(data: Buffer, width: number, height: number): Rgb[] {
  const colors: Rgb[] = [];
  const sample = (x: number, y: number): void => {
    const offset = (y * width + x) * 4;
    colors.push([data[offset]!, data[offset + 1]!, data[offset + 2]!]);
  };

  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }

  return colors;
}

function medianEdgeColor(colors: readonly Rgb[]): Rgb {
  return [
    median(colors.map((color) => color[0])),
    median(colors.map((color) => color[1])),
    median(colors.map((color) => color[2])),
  ];
}

function maxChannelDistance(left: Rgb, right: Rgb): number {
  return Math.max(
    Math.abs(left[0] - right[0]),
    Math.abs(left[1] - right[1]),
    Math.abs(left[2] - right[2]),
  );
}

function hasConsistentEdgeColor(
  colors: readonly Rgb[],
  edgeColor: Rgb,
  tolerance: number,
): boolean {
  const consistentSamples = colors.filter(
    (color) => maxChannelDistance(color, edgeColor) <= tolerance,
  ).length;
  return consistentSamples / colors.length >= MIN_EDGE_COLOR_CONSISTENCY;
}

function removeConnectedBackground(
  data: Buffer,
  width: number,
  height: number,
  edgeColor: Rgb,
  tolerance: number,
): Uint8Array {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const removed = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const inspect = (index: number): void => {
    if (visited[index] === 1) return;
    visited[index] = 1;
    const offset = index * 4;
    const distance = maxChannelDistance(
      [data[offset]!, data[offset + 1]!, data[offset + 2]!],
      edgeColor,
    );
    if (distance <= tolerance) queue[tail++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    inspect(x);
    inspect((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    inspect(y * width);
    inspect(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head++]!;
    removed[index] = 1;
    data[index * 4 + 3] = 0;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) inspect(index - 1);
    if (x + 1 < width) inspect(index + 1);
    if (y > 0) inspect(index - width);
    if (y + 1 < height) inspect(index + width);
  }

  return removed;
}

function applySoftAlphaFringe(
  data: Buffer,
  width: number,
  height: number,
  edgeColor: Rgb,
  tolerance: number,
  removed: Uint8Array,
): void {
  const touchesRemovedBackground = (x: number, y: number): boolean => {
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue;
        const neighborX = x + offsetX;
        const neighborY = y + offsetY;
        if (
          neighborX >= 0 &&
          neighborX < width &&
          neighborY >= 0 &&
          neighborY < height &&
          removed[neighborY * width + neighborX] === 1
        ) {
          return true;
        }
      }
    }
    return false;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (removed[index] === 1 || !touchesRemovedBackground(x, y)) continue;
      const offset = index * 4;
      const observed: Rgb = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
      const distance = maxChannelDistance(observed, edgeColor);
      if (distance >= tolerance + SOFT_ALPHA_COLOR_RANGE) continue;
      const alpha = Math.max(
        1,
        Math.min(
          254,
          Math.round(
            ((distance - tolerance) / SOFT_ALPHA_COLOR_RANGE) * 255,
          ),
        ),
      );
      const alphaFraction = alpha / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        data[offset + channel] = Math.max(
          0,
          Math.min(
            255,
            Math.round(
              (observed[channel]! - (1 - alphaFraction) * edgeColor[channel]!) /
                alphaFraction,
            ),
          ),
        );
      }
      data[offset + 3] = alpha;
    }
  }
}

function calculateAlphaMetrics(
  data: Buffer,
  width: number,
  height: number,
): AlphaMetrics {
  let foregroundPixels = 0;
  let opaqueBorderPixels = 0;
  let perimeterPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const foreground = data[(y * width + x) * 4 + 3]! >= 128;
      if (foreground) foregroundPixels += 1;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        perimeterPixels += 1;
        if (foreground) opaqueBorderPixels += 1;
      }
    }
  }

  const pixelCount = width * height;
  return {
    transparentRatio: (pixelCount - foregroundPixels) / pixelCount,
    opaqueBorderRatio: opaqueBorderPixels / perimeterPixels,
    foregroundPixels,
  };
}

function rectangularFallback(
  image: Buffer,
  metrics: AlphaMetrics,
  fallbackReason: FallbackReason,
): ExtractedAsset {
  return {
    image,
    extraction: "rectangular",
    metrics,
    fallbackReason,
  };
}

function integerCrop(
  bbox: BBox,
  sourceWidth: number,
  sourceHeight: number,
): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.floor(bbox.x));
  const top = Math.max(0, Math.floor(bbox.y));
  const right = Math.min(sourceWidth, Math.ceil(bbox.x + bbox.width));
  const bottom = Math.min(sourceHeight, Math.ceil(bbox.y + bbox.height));
  if (right <= left || bottom <= top) {
    throw new RangeError("Asset bbox does not intersect the source image");
  }
  return { left, top, width: right - left, height: bottom - top };
}

export async function extractAsset(
  source: Buffer,
  bbox: BBox,
  options: ExtractAssetOptions = {},
): Promise<ExtractedAsset> {
  const sourceMetadata = await sharp(source).metadata();
  if (sourceMetadata.width === undefined || sourceMetadata.height === undefined) {
    throw new Error("Source image dimensions are unavailable");
  }

  const crop = integerCrop(bbox, sourceMetadata.width, sourceMetadata.height);
  const rectangularImage = await sharp(source).extract(crop).png().toBuffer();
  if ((options.extraction ?? "transparent") === "rectangular") {
    return {
      image: rectangularImage,
      extraction: "rectangular",
      metrics: {
        transparentRatio: 0,
        opaqueBorderRatio: 0,
        foregroundPixels: 0,
      },
    };
  }

  const { data, info } = await sharp(rectangularImage)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const colorTolerance = options.colorTolerance ?? DEFAULT_COLOR_TOLERANCE;
  if (!Number.isFinite(colorTolerance) || colorTolerance < 0) {
    throw new RangeError("colorTolerance must be a non-negative finite number");
  }
  const sampledEdgeColors = edgeColors(data, info.width, info.height);
  const edgeColor = medianEdgeColor(sampledEdgeColors);
  if (!hasConsistentEdgeColor(sampledEdgeColors, edgeColor, colorTolerance)) {
    return rectangularFallback(
      rectangularImage,
      calculateAlphaMetrics(data, info.width, info.height),
      "edge_colors_inconsistent",
    );
  }
  const removed = removeConnectedBackground(
    data,
    info.width,
    info.height,
    edgeColor,
    colorTolerance,
  );
  applySoftAlphaFringe(
    data,
    info.width,
    info.height,
    edgeColor,
    colorTolerance,
    removed,
  );
  const metrics = calculateAlphaMetrics(data, info.width, info.height);

  if (metrics.transparentRatio < MIN_TRANSPARENT_RATIO) {
    return rectangularFallback(
      rectangularImage,
      metrics,
      "transparent_pixel_ratio_below_5_percent",
    );
  }
  if (metrics.transparentRatio > MAX_TRANSPARENT_RATIO) {
    return rectangularFallback(
      rectangularImage,
      metrics,
      "transparent_pixel_ratio_above_92_percent",
    );
  }
  if (metrics.opaqueBorderRatio > MAX_OPAQUE_BORDER_RATIO) {
    return rectangularFallback(
      rectangularImage,
      metrics,
      "opaque_border_ratio_above_2_percent",
    );
  }

  const image = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return { image, extraction: "transparent", metrics };
}
