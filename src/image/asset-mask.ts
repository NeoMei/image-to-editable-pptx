import sharp from "sharp";

import type { BBox } from "../contracts.js";

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
  if (!Number.isInteger(dilationPx) || dilationPx < 0) {
    throw new RangeError("Asset mask dilation must be a non-negative integer");
  }

  const foreground = new Uint8Array(width * height);
  for (let index = 0; index < foreground.length; index += 1) {
    foreground[index] = data[index * 4 + 3]! >= 16 ? 255 : 0;
  }

  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (foreground[y * width + x] === 0) continue;
      for (let dy = -dilationPx; dy <= dilationPx; dy += 1) {
        for (let dx = -dilationPx; dx <= dilationPx; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            dilated[py * width + px] = 255;
          }
        }
      }
    }
  }

  const canvasMask = Buffer.alloc(canvas.width * canvas.height);
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
        canvasMask[targetY * canvas.width + targetX] =
          dilated[y * width + x]!;
      }
    }
  }

  return sharp(canvasMask, {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  })
    .png()
    .toBuffer();
}
