import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import { extractAsset } from "../src/image/extract.js";

test("removes a cream border connected to the crop edge", async () => {
  const source = await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 3,
      background: "#f7f3e9",
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 12,
            height: 12,
            channels: 3,
            background: "#23394d",
          },
        },
        left: 6,
        top: 6,
      },
    ])
    .png()
    .toBuffer();

  const extracted = await extractAsset(
    source,
    { x: 0, y: 0, width: 24, height: 24 },
    { extraction: "transparent" },
  );
  const { data, info } = await sharp(extracted.image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  assert.equal(extracted.extraction, "transparent");
  assert.equal(extracted.fallbackReason, undefined);
  assert.equal(info.width, 24);
  assert.equal(info.height, 24);
  assert.equal(data[(1 * info.width + 1) * 4 + 3], 0);
  assert.deepEqual(
    [...data.subarray((12 * info.width + 12) * 4, (12 * info.width + 12) * 4 + 4)],
    [35, 57, 77, 255],
  );
});

test("falls back to the rectangular crop when edge colors are not a removable background", async () => {
  const source = await sharp({
    create: {
      width: 20,
      height: 20,
      channels: 3,
      background: "#23394d",
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 10,
            height: 20,
            channels: 3,
            background: "#e65d16",
          },
        },
        left: 10,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  const extracted = await extractAsset(
    source,
    { x: 0, y: 0, width: 20, height: 20 },
    { extraction: "transparent" },
  );
  const { data, info } = await sharp(extracted.image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  assert.equal(extracted.extraction, "rectangular");
  assert.equal(extracted.fallbackReason, "transparent_pixel_ratio_below_5_percent");
  assert.ok(
    Array.from({ length: info.width * info.height }, (_, index) => data[index * 4 + 3]).every(
      (alpha) => alpha === 255,
    ),
  );
});

test("falls back when background removal would erase more than 92 percent", async () => {
  const source = await sharp({
    create: {
      width: 20,
      height: 20,
      channels: 3,
      background: "#f7f3e9",
    },
  })
    .png()
    .toBuffer();

  const extracted = await extractAsset(
    source,
    { x: 0, y: 0, width: 20, height: 20 },
    { extraction: "transparent" },
  );

  assert.equal(extracted.extraction, "rectangular");
  assert.equal(extracted.fallbackReason, "transparent_pixel_ratio_above_92_percent");
});
