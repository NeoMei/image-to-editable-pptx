import sharp from "sharp";

import type { BBox } from "../contracts.js";

function assertMaskDimensions(
  alpha: Uint8Array,
  width: number,
  height: number,
): void {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("Alpha mask dimensions must be positive integers");
  }
  if (alpha.length !== width * height) {
    throw new Error("Alpha mask length does not match its dimensions");
  }
}

export function dilateAlphaMask(
  alpha: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  assertMaskDimensions(alpha, width, height);
  if (!Number.isInteger(radius) || radius < 0) {
    throw new RangeError("Asset mask dilation must be a non-negative integer");
  }
  if (radius === 0) return Uint8Array.from(alpha);

  const dilated = new Uint8Array(alpha.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceAlpha = alpha[y * width + x]!;
      if (sourceAlpha === 0) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const targetX = x + dx;
          const targetY = y + dy;
          if (targetX < 0 || targetX >= width || targetY < 0 || targetY >= height) {
            continue;
          }
          const targetIndex = targetY * width + targetX;
          dilated[targetIndex] = Math.max(dilated[targetIndex]!, sourceAlpha);
        }
      }
    }
  }
  return dilated;
}

export function placeAlphaMask(
  alpha: Uint8Array,
  width: number,
  height: number,
  bbox: BBox,
  canvas: { width: number; height: number },
): Uint8Array {
  assertMaskDimensions(alpha, width, height);
  if (
    !Number.isInteger(canvas.width) ||
    canvas.width <= 0 ||
    !Number.isInteger(canvas.height) ||
    canvas.height <= 0
  ) {
    throw new RangeError("Canvas mask dimensions must be positive integers");
  }
  if (width !== Math.ceil(bbox.width) || height !== Math.ceil(bbox.height)) {
    throw new Error("Alpha mask dimensions do not match candidate bbox");
  }

  const canvasMask = new Uint8Array(canvas.width * canvas.height);
  const left = Math.floor(bbox.x);
  const top = Math.floor(bbox.y);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetX = left + x;
      const targetY = top + y;
      if (
        targetX >= 0 &&
        targetX < canvas.width &&
        targetY >= 0 &&
        targetY < canvas.height
      ) {
        canvasMask[targetY * canvas.width + targetX] = alpha[y * width + x]!;
      }
    }
  }
  return canvasMask;
}

export async function buildAssetRemovalMask(
  asset: Buffer,
  bbox: BBox,
  canvas: { width: number; height: number },
  dilationPx = 2,
): Promise<Buffer> {
  const { data, info } = await sharp(asset)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Math.ceil(bbox.width);
  const height = Math.ceil(bbox.height);
  if (info.width !== width || info.height !== height) {
    throw new Error("Asset dimensions do not match candidate bbox");
  }
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = data[index * 4 + 3]!;
  }
  const dilated = dilateAlphaMask(alpha, width, height, dilationPx);
  const canvasMask = placeAlphaMask(dilated, width, height, bbox, canvas);

  return sharp(canvasMask, {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  })
    .png()
    .toBuffer();
}
