import { readFile, stat } from "node:fs/promises";

import sharp, { type Metadata } from "sharp";

export type SourceFormat = "png" | "jpeg";

export type SourceCanvas = {
  format: SourceFormat;
  width: number;
  height: number;
  rgba: Buffer;
  sourceBytes: Buffer;
};

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MIN_CANVAS_DIMENSION = 64;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_PIXELS = 40_000_000;
const MAX_CANVAS_ASPECT_RATIO = 56;
const SHARP_MAX_INPUT_PIXELS = MAX_CANVAS_DIMENSION ** 2;

function classifySourceFormat(sourceBytes: Buffer): SourceFormat {
  if (
    sourceBytes.length >= 8 &&
    sourceBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "png";
  }
  if (
    sourceBytes.length >= 3 &&
    sourceBytes[0] === 0xff &&
    sourceBytes[1] === 0xd8 &&
    sourceBytes[2] === 0xff
  ) {
    return "jpeg";
  }
  throw new Error("Source image must use PNG or JPEG magic bytes");
}

export function assertSupportedCanvas(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new RangeError("Source image dimensions must be safe integers");
  }
  if (width < MIN_CANVAS_DIMENSION || height < MIN_CANVAS_DIMENSION) {
    throw new RangeError(
      `Source image dimensions must be at least ${MIN_CANVAS_DIMENSION} pixels; received ${width}x${height}`,
    );
  }
  if (width > MAX_CANVAS_DIMENSION || height > MAX_CANVAS_DIMENSION) {
    throw new RangeError(
      `Source image dimensions must be at most ${MAX_CANVAS_DIMENSION} pixels; received ${width}x${height}`,
    );
  }
  if (width * height > MAX_CANVAS_PIXELS) {
    throw new RangeError(
      `Source image must contain at most ${MAX_CANVAS_PIXELS.toLocaleString("en-US")} pixels; received ${(width * height).toLocaleString("en-US")}`,
    );
  }
  if (Math.max(width, height) / Math.min(width, height) > MAX_CANVAS_ASPECT_RATIO) {
    throw new RangeError(
      `Source image aspect ratio must not exceed ${MAX_CANVAS_ASPECT_RATIO}:1; received ${width}:${height}`,
    );
  }
}

export async function decodeSourceImage(path: string): Promise<SourceCanvas> {
  const sourceInfo = await stat(path);
  if (sourceInfo.size > MAX_SOURCE_BYTES) {
    throw new RangeError(
      `Source image must not exceed 50 MiB; received ${sourceInfo.size} bytes`,
    );
  }

  const sourceBytes = await readFile(path);
  if (sourceBytes.length > MAX_SOURCE_BYTES) {
    throw new RangeError(
      `Source image must not exceed 50 MiB; received ${sourceBytes.length} bytes`,
    );
  }
  const format = classifySourceFormat(sourceBytes);
  const input = {
    animated: true,
    failOn: "error" as const,
    limitInputChannels: 4,
    limitInputPixels: SHARP_MAX_INPUT_PIXELS,
  };

  let metadata: Metadata;
  try {
    metadata = await sharp(sourceBytes, input).metadata();
  } catch (error) {
    throw new Error("Source image could not be decoded safely", { cause: error });
  }
  if (metadata.format !== format) {
    throw new Error(
      `Source image magic bytes do not match decoded ${metadata.format ?? "unknown"} content`,
    );
  }
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error("Source image dimensions could not be determined");
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw new Error("Source image must not be animated or multipage");
  }
  assertSupportedCanvas(metadata.width, metadata.height);

  let rgba: Buffer;
  try {
    const decoded = await sharp(sourceBytes, input)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width !== metadata.width ||
      decoded.info.height !== metadata.height ||
      decoded.info.channels !== 4
    ) {
      throw new Error("Canonical RGBA decode produced unexpected dimensions");
    }
    rgba = decoded.data;
  } catch (error) {
    throw new Error("Source image could not be decoded into canonical RGBA", {
      cause: error,
    });
  }

  const expectedLength = metadata.width * metadata.height * 4;
  if (rgba.length !== expectedLength) {
    throw new Error(
      `Canonical RGBA decode must contain exactly ${expectedLength} bytes; received ${rgba.length}`,
    );
  }
  return {
    format,
    width: metadata.width,
    height: metadata.height,
    rgba,
    sourceBytes,
  };
}
