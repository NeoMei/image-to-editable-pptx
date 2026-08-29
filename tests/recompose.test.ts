import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import {
  validateRecomposition,
  validateWholePageRecomposition,
} from "../src/image/recompose.js";

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

test("recomposes every accepted layer in graph order and ignores editable text pixels", async () => {
  const background = await creamCanvas();
  const rear = await blueAsset("#23394d");
  const front = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: 230, g: 93, b: 22, alpha: 0.72 },
    },
  }).png().toBuffer();
  const ordered = [
    { id: "rear", asset: rear, bbox: { x: 8, y: 6, width: 8, height: 8 }, zIndex: 1 },
    { id: "front", asset: front, bbox: { x: 12, y: 8, width: 8, height: 8 }, zIndex: 2 },
  ];
  const withoutText = await sharp(background)
    .composite(ordered.map(({ asset, bbox }) => ({
      input: asset,
      left: bbox.x,
      top: bbox.y,
    })))
    .png()
    .toBuffer();
  const source = await sharp(withoutText)
    .composite([{
      input: await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: "#111111",
        },
      }).png().toBuffer(),
      left: 2,
      top: 2,
    }])
    .png()
    .toBuffer();
  const ignoredPixels = Buffer.alloc(32 * 24);
  for (const index of [2 * 32 + 2, 2 * 32 + 3, 3 * 32 + 2, 3 * 32 + 3]) {
    ignoredPixels[index] = 255;
  }
  const ignoredMask = await sharp(ignoredPixels, {
    raw: { width: 32, height: 24, channels: 1 },
  }).png().toBuffer();

  const result = await validateWholePageRecomposition({
    source,
    background,
    layers: [...ordered].reverse(),
    ignoredMask,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.metrics.meanAbsoluteError, 0);
  assert.deepEqual(result.preview, withoutText);
});

test("attributes an isolated page mismatch but marks overlapping alpha ownership ambiguous", async () => {
  const background = await creamCanvas();
  const correct = await blueAsset("#23394d");
  const source = await sharp(background)
    .composite([{ input: correct, left: 8, top: 8 }])
    .png()
    .toBuffer();
  const wrong = await blueAsset("#ffffff");

  const isolated = await validateWholePageRecomposition({
    source,
    background,
    layers: [{
      id: "isolated-wrong-layer",
      asset: wrong,
      bbox: { x: 8, y: 8, width: 8, height: 8 },
      zIndex: 1,
    }],
  });
  assert.equal(isolated.accepted, false);
  assert.equal(isolated.attribution, "deterministic");
  assert.deepEqual(isolated.affectedLayerIds, ["isolated-wrong-layer"]);

  const translucentWrong = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 0.5 },
    },
  }).png().toBuffer();
  const overlapping = await validateWholePageRecomposition({
    source,
    background,
    layers: [
      {
        id: "rear-owner",
        asset: correct,
        bbox: { x: 8, y: 8, width: 8, height: 8 },
        zIndex: 1,
      },
      {
        id: "partial-front-owner",
        asset: translucentWrong,
        bbox: { x: 8, y: 8, width: 8, height: 8 },
        zIndex: 2,
      },
    ],
  });
  assert.equal(overlapping.accepted, false);
  assert.equal(overlapping.attribution, "ambiguous");
  assert.deepEqual(overlapping.affectedLayerIds, []);
});

test("tolerates a sparse rim of edge deviations within the whole-page ratio budget", async () => {
  const background = await creamCanvas();
  const asset = await blueAsset("#23394d");
  const source = await sharp(background)
    .composite([
      { input: asset, left: 10, top: 8 },
      {
        input: await sharp({
          create: { width: 5, height: 2, channels: 4, background: "#111111" },
        }).png().toBuffer(),
        left: 12,
        top: 10,
      },
    ])
    .png()
    .toBuffer();

  const result = await validateWholePageRecomposition({
    source,
    background,
    layers: [{
      id: "rim-layer",
      asset,
      bbox: { x: 10, y: 8, width: 8, height: 8 },
      zIndex: 1,
    }],
  });

  assert.equal(result.accepted, true);
  assert.ok(result.metrics.changedPixelRatio > 0);
  assert.ok(result.metrics.changedPixelRatio <= 0.02);
});

test("attributes a sparse but above-budget deviation to its owning layer", async () => {
  const background = await creamCanvas();
  const asset = await blueAsset("#23394d");
  const source = await sharp(background)
    .composite([
      { input: asset, left: 10, top: 8 },
      {
        input: await sharp({
          create: { width: 5, height: 4, channels: 4, background: "#111111" },
        }).png().toBuffer(),
        left: 12,
        top: 10,
      },
    ])
    .png()
    .toBuffer();

  const result = await validateWholePageRecomposition({
    source,
    background,
    layers: [{
      id: "sparse-layer",
      asset,
      bbox: { x: 10, y: 8, width: 8, height: 8 },
      zIndex: 1,
    }],
  });

  assert.equal(result.accepted, false);
  assert.equal(result.attribution, "deterministic");
  assert.deepEqual(result.affectedLayerIds, ["sparse-layer"]);
});

test("rejects even a sparse deviation owned by a strict completion layer", async () => {
  const background = await creamCanvas();
  const asset = await blueAsset("#23394d");
  const source = await sharp(background)
    .composite([
      { input: asset, left: 10, top: 8 },
      {
        input: await sharp({
          create: { width: 5, height: 2, channels: 4, background: "#111111" },
        }).png().toBuffer(),
        left: 12,
        top: 10,
      },
    ])
    .png()
    .toBuffer();

  const result = await validateWholePageRecomposition({
    source,
    background,
    layers: [{
      id: "completion-layer",
      asset,
      bbox: { x: 10, y: 8, width: 8, height: 8 },
      zIndex: 1,
      strict: true,
    }],
  });

  assert.equal(result.accepted, false);
  assert.equal(result.attribution, "deterministic");
  assert.deepEqual(result.affectedLayerIds, ["completion-layer"]);
});
