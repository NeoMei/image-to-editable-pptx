import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { buildAssetRemovalMask } from "../src/image/asset-mask.js";

test("places asset alpha at its canvas bbox without masking transparent pixels", async () => {
  const pixels = Buffer.alloc(4 * 4 * 4);
  const foregroundPixels: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ];
  for (const [x, y] of foregroundPixels) {
    pixels[(y * 4 + x) * 4 + 3] = 255;
  }
  const asset = await sharp(pixels, {
    raw: { width: 4, height: 4, channels: 4 },
  })
    .png()
    .toBuffer();
  const mask = await buildAssetRemovalMask(
    asset,
    { x: 10, y: 20, width: 4, height: 4 },
    { width: 32, height: 32 },
    0,
  );
  const raw = await sharp(mask).removeAlpha().raw().toBuffer();
  const value = (x: number, y: number): number => raw[(y * 32 + x) * 3]!;

  assert.equal(value(11, 21), 255);
  assert.equal(value(12, 22), 255);
  assert.equal(value(10, 20), 0);
  assert.equal(value(13, 23), 0);
});

test("dilates alpha by the requested pixel radius", async () => {
  const pixels = Buffer.alloc(3 * 3 * 4);
  pixels[(1 * 3 + 1) * 4 + 3] = 255;
  const asset = await sharp(pixels, {
    raw: { width: 3, height: 3, channels: 4 },
  })
    .png()
    .toBuffer();
  const mask = await buildAssetRemovalMask(
    asset,
    { x: 4, y: 4, width: 3, height: 3 },
    { width: 12, height: 12 },
    1,
  );
  const raw = await sharp(mask).removeAlpha().raw().toBuffer();
  const value = (x: number, y: number): number => raw[(y * 12 + x) * 3]!;

  assert.equal(value(4, 4), 255);
  assert.equal(value(6, 6), 255);
  assert.equal(value(3, 3), 0);
  assert.equal(value(7, 7), 0);
});

test("rejects an asset whose dimensions do not match the candidate bbox", async () => {
  const asset = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: "#23394d",
    },
  })
    .png()
    .toBuffer();

  await assert.rejects(
    buildAssetRemovalMask(
      asset,
      { x: 4, y: 4, width: 3, height: 4 },
      { width: 12, height: 12 },
    ),
    new Error("Asset dimensions do not match candidate bbox"),
  );
});
