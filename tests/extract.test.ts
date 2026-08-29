import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import {
  extractAsset,
  removeBackgroundFromRgba,
} from "../src/image/extract.js";

test("derives a transparent proposal from canonical RGBA without mutating it", () => {
  const width = 12;
  const height = 12;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba.set([247, 243, 233, 255], index * 4);
  }
  for (let y = 3; y < 9; y += 1) {
    for (let x = 3; x < 9; x += 1) {
      rgba.set([35, 57, 77, 255], (y * width + x) * 4);
    }
  }
  const before = Buffer.from(rgba);

  const proposal = removeBackgroundFromRgba(rgba, width, height, 24);

  assert.ok(proposal);
  assert.deepEqual(rgba, before);
  assert.equal(proposal.rgba[(1 * width + 1) * 4 + 3], 0);
  assert.equal(proposal.rgba[(6 * width + 6) * 4 + 3], 255);
  assert.deepEqual(proposal.metrics, {
    transparentRatio: 0.75,
    opaqueBorderRatio: 0,
    foregroundPixels: 36,
  });
});

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
  assert.deepEqual(extracted.metrics, {
    transparentRatio: 0.75,
    opaqueBorderRatio: 0,
    foregroundPixels: 144,
  });
  assert.equal(info.width, 24);
  assert.equal(info.height, 24);
  assert.equal(data[(1 * info.width + 1) * 4 + 3], 0);
  assert.deepEqual(
    [...data.subarray((12 * info.width + 12) * 4, (12 * info.width + 12) * 4 + 4)],
    [35, 57, 77, 255],
  );
});

test("preserves antialiased icon edges as decontaminated partial alpha", async () => {
  const width = 16;
  const height = 16;
  const background = [247, 243, 233] as const;
  const foreground = [35, 57, 77] as const;
  const blended = [194, 197, 194] as const;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(background, index * 3);
  }
  for (let y = 4; y <= 11; y += 1) {
    for (let x = 4; x <= 11; x += 1) {
      const edge = x === 4 || x === 11 || y === 4 || y === 11;
      pixels.set(edge ? blended : foreground, (y * width + x) * 3);
    }
  }
  const source = await sharp(pixels, {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();

  const extracted = await extractAsset(
    source,
    { x: 0, y: 0, width, height },
    { extraction: "transparent" },
  );
  const { data } = await sharp(extracted.image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const edgeOffset = (4 * width + 7) * 4;
  const edgeAlpha = data[edgeOffset + 3]!;

  assert.equal(extracted.extraction, "transparent");
  assert.ok(edgeAlpha > 0 && edgeAlpha < 255);
  assert.ok(data[edgeOffset]! < blended[0]);
  assert.equal(data[(7 * width + 7) * 4 + 3], 255);
});

test("falls back when foreground occupies more than two percent of the crop perimeter", async () => {
  const source = await sharp({
    create: {
      width: 20,
      height: 20,
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
        left: 4,
        top: 4,
      },
      {
        input: {
        create: {
          width: 2,
          height: 1,
          channels: 3,
          background: "#23394d",
        },
        },
        left: 9,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  const extracted = await extractAsset(
    source,
    { x: 0, y: 0, width: 24, height: 24 },
    { extraction: "transparent" },
  );

  assert.equal(extracted.extraction, "rectangular");
  assert.equal(
    extracted.fallbackReason,
    "opaque_border_ratio_above_2_percent",
  );
  assert.deepEqual(extracted.metrics, {
    transparentRatio: 254 / 400,
    opaqueBorderRatio: 2 / 76,
    foregroundPixels: 146,
  });
});

test("reports zero alpha metrics when rectangular extraction is explicitly requested", async () => {
  const source = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: "#23394d",
    },
  })
    .png()
    .toBuffer();

  const extracted = await extractAsset(
    source,
    { x: 0, y: 0, width: 8, height: 8 },
    { extraction: "rectangular" },
  );

  assert.deepEqual(extracted.metrics, {
    transparentRatio: 0,
    opaqueBorderRatio: 0,
    foregroundPixels: 0,
  });
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
  assert.equal(extracted.fallbackReason, "edge_colors_inconsistent");
  assert.ok(
    Array.from({ length: info.width * info.height }, (_, index) => data[index * 4 + 3]).every(
      (alpha) => alpha === 255,
    ),
  );
});

test("rejects materially different edge colors when one color is an imbalanced minority", async () => {
  const source = await sharp({
    create: {
      width: 25,
      height: 20,
      channels: 3,
      background: "#23394d",
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 5,
            height: 20,
            channels: 3,
            background: "#e65d16",
          },
        },
        left: 20,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  const extracted = await extractAsset(
    source,
    { x: 0, y: 0, width: 25, height: 20 },
    { extraction: "transparent" },
  );

  assert.equal(extracted.extraction, "rectangular");
  assert.equal(extracted.fallbackReason, "edge_colors_inconsistent");
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

test("falls back unchanged when a one-pixel connected perimeter is below five percent", async () => {
  const source = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 3,
      background: "#f7f3e9",
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 98,
            height: 98,
            channels: 3,
            background: "#23394d",
          },
        },
        left: 1,
        top: 1,
      },
    ])
    .png()
    .toBuffer();

  const extracted = await extractAsset(
    source,
    { x: 0, y: 0, width: 100, height: 100 },
    { extraction: "transparent" },
  );
  const [sourcePixels, extractedPixels] = await Promise.all([
    sharp(source).raw().toBuffer(),
    sharp(extracted.image).raw().toBuffer(),
  ]);

  assert.equal(extracted.extraction, "rectangular");
  assert.equal(
    extracted.fallbackReason,
    "transparent_pixel_ratio_below_5_percent",
  );
  assert.deepEqual(extractedPixels, sourcePixels);
});

test("strips detached fragments far from the dominant component and zeroes transparent RGB", () => {
  const width = 40;
  const height = 40;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba.set([247, 243, 233, 255], index * 4);
  }
  for (let y = 4; y < 16; y += 1) {
    for (let x = 4; x < 16; x += 1) {
      rgba.set([35, 57, 77, 255], (y * width + x) * 4);
    }
  }
  for (let y = 6; y < 9; y += 1) {
    for (let x = 19; x < 22; x += 1) {
      rgba.set([35, 57, 77, 255], (y * width + x) * 4);
    }
  }
  for (let y = 26; y < 31; y += 1) {
    for (let x = 30; x < 35; x += 1) {
      rgba.set([35, 57, 77, 255], (y * width + x) * 4);
    }
  }

  const proposal = removeBackgroundFromRgba(rgba, width, height, 24);

  assert.ok(proposal);
  const fragmentOffset = (28 * width + 32) * 4;
  assert.equal(proposal.rgba[fragmentOffset + 3]!, 0);
  assert.deepEqual(
    [...proposal.rgba.subarray(fragmentOffset, fragmentOffset + 3)],
    [0, 0, 0],
  );
  assert.equal(proposal.rgba[(10 * width + 10) * 4 + 3], 255);
  assert.equal(proposal.rgba[(7 * width + 20) * 4 + 3], 255);
  const backgroundOffset = (1 * width + 1) * 4;
  assert.equal(proposal.rgba[backgroundOffset + 3]!, 0);
  assert.equal(proposal.rgba[backgroundOffset]!, 0);
});

test("keeps balanced multi-part icons when no dominant component exists", () => {
  const width = 40;
  const height = 40;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba.set([247, 243, 233, 255], index * 4);
  }
  for (let y = 8; y < 32; y += 1) {
    for (let x = 10; x < 16; x += 1) {
      rgba.set([35, 57, 77, 255], (y * width + x) * 4);
    }
    for (let x = 25; x < 31; x += 1) {
      rgba.set([35, 57, 77, 255], (y * width + x) * 4);
    }
  }

  const proposal = removeBackgroundFromRgba(rgba, width, height, 24);

  assert.ok(proposal);
  assert.equal(proposal.rgba[(20 * width + 12) * 4 + 3], 255);
  assert.equal(proposal.rgba[(20 * width + 27) * 4 + 3], 255);
});
