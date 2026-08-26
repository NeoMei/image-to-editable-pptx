import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { repairLocalRegion } from "../src/image/local-repair.js";

async function encodeRgb(
  data: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function encodeMask(
  data: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function encodeRgba(
  data: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

test("fills a small hole from the nearest same-surface pixels", async () => {
  const width = 12;
  const height = 8;
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const value = 240 + (index % 5) - 2;
    rgb[index * 3] = value;
    rgb[index * 3 + 1] = value - 4;
    rgb[index * 3 + 2] = value - 10;
  }
  const mask = Buffer.alloc(width * height);
  for (const [x, y] of [
    [5, 3],
    [6, 3],
    [5, 4],
    [6, 4],
  ] as const) {
    mask[y * width + x] = 255;
    rgb[(y * width + x) * 3] = 20;
    rgb[(y * width + x) * 3 + 1] = 20;
    rgb[(y * width + x) * 3 + 2] = 20;
  }
  const result = await repairLocalRegion(
    await encodeRgb(rgb, width, height),
    await encodeMask(mask, width, height),
  );
  const output = await sharp(result.image).removeAlpha().raw().toBuffer();
  assert.equal(result.accepted, true);
  assert.equal(result.metrics.maskedPixels, 4);
  assert.ok(output[(3 * width + 5) * 3]! >= 235);
});

test("does not change any pixel outside the mask", async () => {
  const width = 8;
  const height = 6;
  const rgb = Buffer.alloc(width * height * 3, 220);
  const mask = Buffer.alloc(width * height);
  mask[3 * width + 4] = 255;
  const source = await encodeRgb(rgb, width, height);
  const result = await repairLocalRegion(
    source,
    await encodeMask(mask, width, height),
  );
  const [before, after] = await Promise.all([
    sharp(source).ensureAlpha().raw().toBuffer(),
    sharp(result.image).ensureAlpha().raw().toBuffer(),
  ]);
  assert.equal(result.accepted, true);
  for (let index = 0; index < width * height; index += 1) {
    if (mask[index] !== 0) continue;
    assert.deepEqual(
      after.subarray(index * 4, index * 4 + 4),
      before.subarray(index * 4, index * 4 + 4),
    );
  }
  assert.equal(result.metrics.outsideMaskChangedPixels, 0);
});

test("rejects a mask whose sampling ring crosses incompatible surfaces", async () => {
  const width = 12;
  const height = 8;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = x < width / 2 ? [35, 57, 77] : [230, 93, 22];
      const offset = (y * width + x) * 3;
      rgb.set(color, offset);
    }
  }
  const mask = Buffer.alloc(width * height);
  for (let y = 2; y <= 5; y += 1) {
    for (let x = 5; x <= 6; x += 1) mask[y * width + x] = 255;
  }
  const source = await encodeRgb(rgb, width, height);
  const result = await repairLocalRegion(
    source,
    await encodeMask(mask, width, height),
  );
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "surface_variance_too_high");
  assert.deepEqual(result.image, source);
});

test("rejects a repair whose filled-pixel p95 exceeds 28", async () => {
  const width = 12;
  const height = 12;
  const rgb = Buffer.alloc(width * height * 3, 100);
  const mask = Buffer.alloc(width * height);
  for (let y = 4; y <= 7; y += 1) {
    for (let x = 4; x <= 7; x += 1) mask[y * width + x] = 255;
  }
  const ring: Array<readonly [number, number]> = [];
  for (let y = 3; y <= 8; y += 1) {
    for (let x = 3; x <= 8; x += 1) {
      if (x >= 4 && x <= 7 && y >= 4 && y <= 7) continue;
      ring.push([x, y]);
    }
  }
  for (const [x, y] of ring.slice(0, 5)) {
    rgb[(y * width + x) * 3] = 160;
  }
  const source = await encodeRgb(rgb, width, height);
  const result = await repairLocalRegion(
    source,
    await encodeMask(mask, width, height),
  );

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "filled_pixels_too_different");
  assert.ok(result.metrics.filledPixelDistanceP95 > 28);
  assert.deepEqual(result.image, source);
});

test("ignores extreme ring outliers when seeding a uniform-surface repair", async () => {
  const width = 20;
  const height = 12;
  const surface = [240, 235, 225] as const;
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    rgb.set(surface, index * 3);
  }
  const mask = Buffer.alloc(width * height);
  for (let y = 3; y <= 8; y += 1) {
    for (let x = 4; x <= 15; x += 1) {
      mask[y * width + x] = 255;
      rgb.set([30, 30, 30], (y * width + x) * 3);
    }
  }
  for (const x of [8, 9, 10]) {
    rgb.set([10, 10, 10], (2 * width + x) * 3);
  }
  const source = await encodeRgb(rgb, width, height);
  const encodedMask = await encodeMask(mask, width, height);

  const [first, second] = await Promise.all([
    repairLocalRegion(source, encodedMask),
    repairLocalRegion(source, encodedMask),
  ]);

  assert.equal(first.accepted, true);
  assert.equal(first.metrics.outsideMaskChangedPixels, 0);
  assert.ok(first.metrics.ringSamples >= 16);
  assert.deepEqual(first.image, second.image);
  assert.deepEqual(first.metrics, second.metrics);
});

test("harmonic smoothing removes a hard nearest-seed split and preserves alpha", async () => {
  const width = 48;
  const height = 24;
  const rgba = Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = x < width / 2 ? [90, 95, 100] : [120, 125, 130];
      rgba.set(color, offset);
      rgba[offset + 3] = 180 + ((x + y) % 60);
      if (x >= 8 && x <= 39 && y >= 9 && y <= 14) {
        mask[y * width + x] = 255;
        rgba.set([20, 20, 20], offset);
      }
    }
  }
  const source = await encodeRgba(rgba, width, height);
  const result = await repairLocalRegion(
    source,
    await encodeMask(mask, width, height),
  );
  const output = await sharp(result.image)
    .ensureAlpha()
    .raw()
    .toBuffer();
  let maxAdjacentChannelDelta = 0;
  for (let y = 10; y <= 13; y += 1) {
    for (let x = 8; x < 39; x += 1) {
      const left = (y * width + x) * 4;
      const right = left + 4;
      for (let channel = 0; channel < 3; channel += 1) {
        maxAdjacentChannelDelta = Math.max(
          maxAdjacentChannelDelta,
          Math.abs(output[left + channel]! - output[right + channel]!),
        );
      }
    }
  }

  assert.equal(result.accepted, true);
  assert.ok(
    maxAdjacentChannelDelta <= 8,
    `expected a smooth interpolation, got adjacent delta ${maxAdjacentChannelDelta}`,
  );
  for (let index = 0; index < width * height; index += 1) {
    assert.equal(output[index * 4 + 3], rgba[index * 4 + 3]);
  }
});
