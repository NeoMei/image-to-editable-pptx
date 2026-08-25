import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import type { TextSlideElement } from "../src/contracts.js";
import { buildTightTextMask } from "../src/image/text-mask.js";

function textElement(
  id: string,
  bbox: TextSlideElement["bbox"],
): TextSlideElement {
  return {
    kind: "text",
    id,
    text: "A",
    bbox,
    rotation: 0,
    color: "FFFFFF",
    fontSizePx: 18,
    align: "left",
    zIndex: 100,
  };
}

async function encodeRgb(
  data: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function decodeMask(mask: Buffer) {
  return sharp(mask).raw().toBuffer({ resolveWithObject: true });
}

test("masks contrasting glyph pixels without masking the full OCR box", async () => {
  const width = 16;
  const height = 10;
  const raw = Buffer.alloc(width * height * 3, 30);
  for (const [x, y] of [
    [6, 4],
    [7, 4],
    [7, 5],
  ]) {
    const offset = (y! * width + x!) * 3;
    raw[offset] = 240;
    raw[offset + 1] = 240;
    raw[offset + 2] = 240;
  }
  const source = await encodeRgb(raw, width, height);
  const element = textElement("ocr-1", { x: 4, y: 2, width: 8, height: 6 });

  const result = await buildTightTextMask(source, element, { dilationPx: 0 });
  const metadata = await sharp(result.mask).metadata();
  const { data, info } = await decodeMask(result.mask);
  const value = (x: number, y: number) =>
    data[(y * info.width + x) * info.channels];

  assert.equal(metadata.channels, 1);
  assert.equal(result.maskedPixels, 3);
  assert.equal(value(6, 4), 255);
  assert.equal(value(4, 2), 0);
  assert.equal(value(11, 7), 0);
  assert.deepEqual(result.surfaceRgb, [30, 30, 30]);
});

test("rejects an OCR box whose perimeter crosses incompatible surfaces", async () => {
  const width = 16;
  const height = 10;
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = x < width / 2 ? 30 : 200;
      raw.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }

  await assert.rejects(
    buildTightTextMask(
      await encodeRgb(raw, width, height),
      textElement("cross-surface", { x: 4, y: 2, width: 8, height: 6 }),
      { dilationPx: 0 },
    ),
    /Text mask surface is not locally consistent/,
  );
});

test("caps oversized dilation at one quarter of text height", async () => {
  const width = 20;
  const height = 16;
  const raw = Buffer.alloc(width * height * 3, 30);
  raw.fill(240, (8 * width + 10) * 3, (8 * width + 10) * 3 + 3);
  const result = await buildTightTextMask(
    await encodeRgb(raw, width, height),
    textElement("capped-dilation", { x: 4, y: 4, width: 12, height: 8 }),
    { dilationPx: 20 },
  );
  const { data, info } = await decodeMask(result.mask);
  const value = (x: number, y: number) =>
    data[(y * info.width + x) * info.channels];

  assert.equal(result.maskedPixels, 25);
  assert.equal(value(8, 6), 255);
  assert.equal(value(7, 5), 0);
  assert.equal(value(4, 4), 0);
  assert.equal(value(13, 8), 0);
});

test("rejects dilation that would cover at least 85 percent of the OCR box", async () => {
  const width = 8;
  const height = 8;
  const raw = Buffer.alloc(width * height * 3, 30);
  for (const [x, y] of [
    [3, 3],
    [4, 3],
    [3, 4],
    [4, 4],
  ]) {
    raw.fill(240, (y! * width + x!) * 3, (y! * width + x!) * 3 + 3);
  }

  await assert.rejects(
    buildTightTextMask(
      await encodeRgb(raw, width, height),
      textElement("post-dilation-over-mask", {
        x: 2,
        y: 2,
        width: 4,
        height: 4,
      }),
      { dilationPx: 1 },
    ),
    /Text mask would remove too much of the OCR box for post-dilation-over-mask/,
  );
});

test("does not dilate a glyph pixel outside the clamped OCR box", async () => {
  const width = 10;
  const height = 10;
  const raw = Buffer.alloc(width * height * 3, 30);
  raw.fill(240, (4 * width + 3) * 3, (4 * width + 3) * 3 + 3);
  const result = await buildTightTextMask(
    await encodeRgb(raw, width, height),
    textElement("bounded-dilation", { x: 3, y: 3, width: 4, height: 4 }),
    { dilationPx: 1 },
  );
  const { data, info } = await decodeMask(result.mask);
  const value = (x: number, y: number) =>
    data[(y * info.width + x) * info.channels];

  assert.equal(value(2, 4), 0);
  assert.equal(value(3, 4), 255);
});

test("rejects a competing structural region covering most of the OCR box", async () => {
  const width = 8;
  const height = 8;
  const raw = Buffer.alloc(width * height * 3, 30);
  for (let y = 2; y < 6; y += 1) {
    for (let x = 2; x < 6; x += 1) {
      if ((x === 2 && y === 2) || (x === 5 && y === 5)) continue;
      raw.fill(240, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }

  await assert.rejects(
    buildTightTextMask(
      await encodeRgb(raw, width, height),
      textElement("structural-over-mask", {
        x: 2,
        y: 2,
        width: 4,
        height: 4,
      }),
      { dilationPx: 0 },
    ),
    /Text mask would remove too much of the OCR box for structural-over-mask/,
  );
});

test("rejects a local surface ring with fewer than eight samples", async () => {
  const source = await encodeRgb(Buffer.alloc(2 * 2 * 3, 30), 2, 2);

  await assert.rejects(
    buildTightTextMask(
      source,
      textElement("no-safe-ring", { x: 0, y: 0, width: 2, height: 2 }),
    ),
    /Text mask surface is not locally consistent/,
  );
});

test("rejects a text box with no contrasting glyph pixels", async () => {
  const source = await encodeRgb(Buffer.alloc(16 * 10 * 3, 30), 16, 10);

  await assert.rejects(
    buildTightTextMask(
      source,
      textElement("missing-glyph", { x: 4, y: 2, width: 8, height: 6 }),
    ),
    /Text mask did not find contrasting glyph pixels for missing-glyph/,
  );
});

test("rejects a threshold that would mask the entire OCR box", async () => {
  const width = 16;
  const height = 10;
  const raw = Buffer.alloc(width * height * 3, 30);
  raw.fill(240, (4 * width + 6) * 3, (4 * width + 6) * 3 + 3);

  await assert.rejects(
    buildTightTextMask(
      await encodeRgb(raw, width, height),
      textElement("unsafe-full-box", { x: 4, y: 2, width: 8, height: 6 }),
      { colorDistance: 0, dilationPx: 0 },
    ),
    /Text mask would remove the full OCR box for unsafe-full-box/,
  );
});

test("rejects non-finite or negative mask options", async () => {
  const source = await encodeRgb(Buffer.alloc(16 * 10 * 3, 30), 16, 10);
  const element = textElement("invalid-options", {
    x: 4,
    y: 2,
    width: 8,
    height: 6,
  });
  const invalidOptions = [
    { colorDistance: -1 },
    { colorDistance: Number.POSITIVE_INFINITY },
    { dilationPx: -1 },
    { dilationPx: Number.NaN },
  ];

  for (const options of invalidOptions) {
    await assert.rejects(
      buildTightTextMask(source, element, options),
      /must be a non-negative finite number/,
    );
  }
});
