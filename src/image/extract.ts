import sharp from "sharp";

import type { BBox } from "../contracts.js";

const DEFAULT_COLOR_TOLERANCE = 24;
const MIN_TRANSPARENT_RATIO = 0.05;
const MAX_TRANSPARENT_RATIO = 0.92;

export type AssetExtraction = "transparent" | "rectangular";

export type ExtractAssetOptions = {
  extraction?: AssetExtraction;
  colorTolerance?: number;
};

export type ExtractedAsset = {
  image: Buffer;
  extraction: AssetExtraction;
  fallbackReason?:
    | "transparent_pixel_ratio_below_5_percent"
    | "transparent_pixel_ratio_above_92_percent";
};

type Rgb = readonly [number, number, number];

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  const upper = values[middle]!;
  return values.length % 2 === 0 ? (values[middle - 1]! + upper) / 2 : upper;
}

function medianEdgeColor(data: Buffer, width: number, height: number): Rgb {
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const sample = (x: number, y: number): void => {
    const offset = (y * width + x) * 4;
    red.push(data[offset]!);
    green.push(data[offset + 1]!);
    blue.push(data[offset + 2]!);
  };

  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }

  return [median(red), median(green), median(blue)];
}

function removeConnectedBackground(
  data: Buffer,
  width: number,
  height: number,
  edgeColor: Rgb,
  tolerance: number,
): number {
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const inspect = (index: number): void => {
    if (visited[index] === 1) return;
    visited[index] = 1;
    const offset = index * 4;
    const distance = Math.max(
      Math.abs(data[offset]! - edgeColor[0]),
      Math.abs(data[offset + 1]! - edgeColor[1]),
      Math.abs(data[offset + 2]! - edgeColor[2]),
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
    data[index * 4 + 3] = 0;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) inspect(index - 1);
    if (x + 1 < width) inspect(index + 1);
    if (y > 0) inspect(index - width);
    if (y + 1 < height) inspect(index + width);
  }

  return tail;
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
    return { image: rectangularImage, extraction: "rectangular" };
  }

  const { data, info } = await sharp(rectangularImage)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const colorTolerance = options.colorTolerance ?? DEFAULT_COLOR_TOLERANCE;
  if (!Number.isFinite(colorTolerance) || colorTolerance < 0) {
    throw new RangeError("colorTolerance must be a non-negative finite number");
  }
  const transparentPixels = removeConnectedBackground(
    data,
    info.width,
    info.height,
    medianEdgeColor(data, info.width, info.height),
    colorTolerance,
  );
  const transparentRatio = transparentPixels / (info.width * info.height);

  if (transparentRatio < MIN_TRANSPARENT_RATIO) {
    return {
      image: rectangularImage,
      extraction: "rectangular",
      fallbackReason: "transparent_pixel_ratio_below_5_percent",
    };
  }
  if (transparentRatio > MAX_TRANSPARENT_RATIO) {
    return {
      image: rectangularImage,
      extraction: "rectangular",
      fallbackReason: "transparent_pixel_ratio_above_92_percent",
    };
  }

  const image = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  return { image, extraction: "transparent" };
}
