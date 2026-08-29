import sharp from "sharp";

import type { BBox } from "../contracts.js";

const DEFAULT_COLOR_TOLERANCE = 24;
const MIN_EDGE_COLOR_CONSISTENCY = 0.85;
const MIN_TRANSPARENT_RATIO = 0.05;
const MAX_TRANSPARENT_RATIO = 0.92;
const MAX_OPAQUE_BORDER_RATIO = 0.02;
const SOFT_ALPHA_COLOR_RANGE = 96;
const MIN_DOMINANT_COMPONENT_SHARE = 0.6;
const SATELLITE_GAP_DIAGONAL_RATIO = 0.1;
const MIN_SATELLITE_GAP_PX = 4;

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

export type BackgroundRemovalProposal = {
  rgba: Buffer;
  metrics: AlphaMetrics;
};

export type BackgroundRemovalOptions = {
  removeInteriorMatches?: boolean;
  minimumEdgeColorConsistency?: number;
};

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
  minimumConsistency = MIN_EDGE_COLOR_CONSISTENCY,
): boolean {
  const consistentSamples = colors.filter(
    (color) => maxChannelDistance(color, edgeColor) <= tolerance,
  ).length;
  return consistentSamples / colors.length >= minimumConsistency;
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

function foregroundComponentsSinceRemoval(
  data: Buffer,
  width: number,
  height: number,
  removed: Uint8Array,
): number[][] {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);
  const components: number[][] = [];
  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] === 1) continue;
    if (removed[start] === 1 || data[start * 4 + 3]! === 0) {
      visited[start] = 1;
      continue;
    }
    visited[start] = 1;
    let top = 0;
    stack[top++] = start;
    const component: number[] = [];
    while (top > 0) {
      const index = stack[--top]!;
      component.push(index);
      const x = index % width;
      const y = (index - x) / width;
      const consider = (next: number): void => {
        if (visited[next] === 1) return;
        if (removed[next] === 1 || data[next * 4 + 3]! === 0) {
          visited[next] = 1;
          return;
        }
        visited[next] = 1;
        stack[top++] = next;
      };
      if (x > 0) consider(index - 1);
      if (x + 1 < width) consider(index + 1);
      if (y > 0) consider(index - width);
      if (y + 1 < height) consider(index + width);
    }
    components.push(component);
  }
  return components.sort((left, right) => right.length - left.length);
}

function minSquaredComponentDistance(
  satellite: readonly number[],
  dominant: readonly number[],
  width: number,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const satelliteIndex of satellite) {
    const satelliteX = satelliteIndex % width;
    const satelliteY = (satelliteIndex - satelliteX) / width;
    for (const dominantIndex of dominant) {
      const dominantX = dominantIndex % width;
      const deltaX = dominantX - satelliteX;
      const deltaY = (dominantIndex - dominantX) / width - satelliteY;
      const squared = deltaX * deltaX + deltaY * deltaY;
      if (squared < minimum) minimum = squared;
      if (minimum <= 1) return minimum;
    }
  }
  return minimum;
}

function componentBounds(
  component: readonly number[],
  width: number,
): { left: number; right: number; top: number; bottom: number } {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const index of component) {
    const x = index % width;
    const y = (index - x) / width;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return { left, right, top, bottom };
}

function squaredBoundsDistance(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): number {
  const deltaX = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
  const deltaY = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
  return deltaX * deltaX + deltaY * deltaY;
}

function stripDetachedSatelliteFragments(
  rgba: Buffer,
  width: number,
  height: number,
  removed: Uint8Array,
): void {
  const components = foregroundComponentsSinceRemoval(rgba, width, height, removed);
  if (components.length <= 1) return;
  const dominant = components[0]!;
  const dominantBounds = componentBounds(dominant, width);
  const totalForeground = components.reduce(
    (total, component) => total + component.length,
    0,
  );
  if (dominant.length / totalForeground < MIN_DOMINANT_COMPONENT_SHARE) return;
  const gapLimit = Math.max(
    MIN_SATELLITE_GAP_PX,
    SATELLITE_GAP_DIAGONAL_RATIO * Math.hypot(width, height),
  );
  const gapLimitSquared = gapLimit * gapLimit;
  for (const satellite of components.slice(1)) {
    const satelliteBounds = componentBounds(satellite, width);
    const boundsDistance = squaredBoundsDistance(satelliteBounds, dominantBounds);
    if (
      boundsDistance <= gapLimitSquared &&
      minSquaredComponentDistance(satellite, dominant, width) <= gapLimitSquared
    ) {
      continue;
    }
    for (const index of satellite) {
      removed[index] = 1;
      rgba[index * 4 + 3] = 0;
    }
  }
}

function zeroRgbBehindFullyTransparentPixels(
  rgba: Buffer,
  width: number,
  height: number,
): void {
  for (let index = 0; index < width * height; index += 1) {
    if (rgba[index * 4 + 3] !== 0) continue;
    const offset = index * 4;
    rgba[offset] = 0;
    rgba[offset + 1] = 0;
    rgba[offset + 2] = 0;
  }
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

export function removeBackgroundFromRgba(
  sourceRgba: Buffer,
  width: number,
  height: number,
  colorTolerance = DEFAULT_COLOR_TOLERANCE,
  options: BackgroundRemovalOptions = {},
): BackgroundRemovalProposal | undefined {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("RGBA dimensions must be positive integers");
  }
  if (sourceRgba.length !== width * height * 4) {
    throw new Error("RGBA buffer length does not match its dimensions");
  }
  if (!Number.isFinite(colorTolerance) || colorTolerance < 0) {
    throw new RangeError("colorTolerance must be a non-negative finite number");
  }
  const minimumEdgeColorConsistency =
    options.minimumEdgeColorConsistency ?? MIN_EDGE_COLOR_CONSISTENCY;
  if (
    !Number.isFinite(minimumEdgeColorConsistency) ||
    minimumEdgeColorConsistency < 0 ||
    minimumEdgeColorConsistency > 1
  ) {
    throw new RangeError("minimumEdgeColorConsistency must be between zero and one");
  }

  const rgba = Buffer.from(sourceRgba);
  const sampledEdgeColors = edgeColors(rgba, width, height);
  const edgeColor = medianEdgeColor(sampledEdgeColors);
  if (
    !hasConsistentEdgeColor(
      sampledEdgeColors,
      edgeColor,
      colorTolerance,
      minimumEdgeColorConsistency,
    )
  ) {
    return undefined;
  }
  const removed = removeConnectedBackground(
    rgba,
    width,
    height,
    edgeColor,
    colorTolerance,
  );
  if (options.removeInteriorMatches === true) {
    for (let index = 0; index < width * height; index += 1) {
      if (removed[index] === 1) continue;
      const offset = index * 4;
      const observed: Rgb = [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!];
      if (maxChannelDistance(observed, edgeColor) <= colorTolerance) {
        removed[index] = 1;
        rgba[offset + 3] = 0;
      }
    }
  }
  stripDetachedSatelliteFragments(rgba, width, height, removed);
  applySoftAlphaFringe(rgba, width, height, edgeColor, colorTolerance, removed);
  zeroRgbBehindFullyTransparentPixels(rgba, width, height);
  return { rgba, metrics: calculateAlphaMetrics(rgba, width, height) };
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
  const proposal = removeBackgroundFromRgba(
    data,
    info.width,
    info.height,
    options.colorTolerance ?? DEFAULT_COLOR_TOLERANCE,
  );
  if (proposal === undefined) {
    return rectangularFallback(
      rectangularImage,
      calculateAlphaMetrics(data, info.width, info.height),
      "edge_colors_inconsistent",
    );
  }
  const { rgba, metrics } = proposal;

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

  const image = await sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return { image, extraction: "transparent", metrics };
}
