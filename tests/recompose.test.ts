import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { validateRecomposition } from "../src/image/recompose.js";

async function creamCanvas(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: "#f7f3e9",
    },
  }).png().toBuffer();
}

async function blueAsset(background: string): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background,
    },
  }).png().toBuffer();
}

test("accepts an icon that reconstructs the source within threshold", async () => {
  const background = await creamCanvas();
  const asset = await blueAsset("#23394d");
  const source = await sharp(background)
    .composite([{ input: asset, left: 10, top: 8 }])
    .png()
    .toBuffer();
  const result = await validateRecomposition({
    source,
    background,
    asset,
    bbox: { x: 10, y: 8, width: 8, height: 8 },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.metrics.meanAbsoluteError, 0);
  assert.equal(result.metrics.p95ChannelDelta, 0);
  assert.equal(result.metrics.changedPixelRatio, 0);
});

test("rejects a rectangular or hallucinated reconstruction", async () => {
  const background = await creamCanvas();
  const correct = await blueAsset("#23394d");
  const source = await sharp(background)
    .composite([{ input: correct, left: 10, top: 8 }])
    .png()
    .toBuffer();
  const wrong = await blueAsset("#ffffff");
  const result = await validateRecomposition({
    source,
    background,
    asset: wrong,
    bbox: { x: 10, y: 8, width: 8, height: 8 },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "recomposition_mismatch");
  assert.ok(result.metrics.p95ChannelDelta > 12);
});
