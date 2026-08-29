import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import type { TextSlideElement } from "../src/contracts.js";
import { inferEditableTextStyle } from "../src/fidelity/text-style.js";
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

async function encodeMask(
  data: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function decodeMask(mask: Buffer) {
  return sharp(mask).raw().toBuffer({ resolveWithObject: true });
}

test("infers light glyph color on a dark local surface", async () => {
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
  assert.deepEqual(result.glyphRgb, [240, 240, 240]);
});

test("infers dark glyph color on a light local surface", async () => {
  const width = 16;
  const height = 10;
  const raw = Buffer.alloc(width * height * 3, 240);
  for (const [x, y] of [
    [6, 4],
    [7, 4],
    [7, 5],
  ]) {
    const offset = (y! * width + x!) * 3;
    raw[offset] = 20;
    raw[offset + 1] = 30;
    raw[offset + 2] = 40;
  }

  const result = await buildTightTextMask(
    await encodeRgb(raw, width, height),
    textElement("dark-glyph", { x: 4, y: 2, width: 8, height: 6 }),
    { dilationPx: 0 },
  );

  assert.deepEqual(result.surfaceRgb, [240, 240, 240]);
  assert.deepEqual(result.glyphRgb, [20, 30, 40]);
});

test("measures thin and thick pre-dilation glyph strokes for style inference", async () => {
  const width = 40;
  const height = 30;
  const element = textElement("stroke-geometry", {
    x: 10,
    y: 5,
    width: 15,
    height: 18,
  });
  const makeSource = async (strokeWidth: number) => {
    const raw = Buffer.alloc(width * height * 3, 240);
    for (let y = 6; y < 22; y += 1) {
      for (let x = 14; x < 14 + strokeWidth; x += 1) {
        raw.fill(30, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
    }
    return encodeRgb(raw, width, height);
  };

  const thin = await buildTightTextMask(await makeSource(1), element, {
    dilationPx: 0,
  });
  const thick = await buildTightTextMask(await makeSource(3), element, {
    dilationPx: 0,
  });

  assert.deepEqual(thin.glyphBounds, { x: 14, y: 6, width: 1, height: 16 });
  assert.deepEqual(thick.glyphBounds, { x: 14, y: 6, width: 3, height: 16 });
  assert.equal(thin.estimatedStrokeWidthPx, 1);
  assert.equal(thick.estimatedStrokeWidthPx, 3);
  assert.ok(thin.inBoxForegroundCoverage < thick.inBoxForegroundCoverage);
  assert.equal(inferEditableTextStyle("I", element.bbox, thin).bold, false);
  assert.equal(inferEditableTextStyle("I", element.bbox, thick).bold, true);
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

test("bounds dilation to one requested pixel beyond the OCR box", async () => {
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

  assert.equal(value(1, 4), 0);
  assert.equal(value(2, 4), 255);
  assert.equal(value(3, 4), 255);
});

test("accepts a two-pixel connected glyph fringe at the ratio boundary", async () => {
  const width = 18;
  const height = 14;
  const raw = Buffer.alloc(width * height * 3, 30);
  for (let y = 3; y < 11; y += 1) {
    raw.fill(240, (y * width + 8) * 3, (y * width + 8) * 3 + 3);
  }
  for (const y of [5, 6]) raw.fill(240, (y * width + 9) * 3, (y * width + 9) * 3 + 3);
  const result = await buildTightTextMask(
    await encodeRgb(raw, width, height),
    textElement("edge-fringe", { x: 4, y: 2, width: 5, height: 10 }),
    { dilationPx: 0 },
  );
  const { data, info } = await decodeMask(result.mask);
  const value = (x: number, y: number) =>
    data[(y * info.width + x) * info.channels];

  assert.equal(value(8, 5), 255);
  assert.equal(value(9, 5), 255);
  assert.equal(value(10, 5), 0);
});

test("rejects connected fringe whose outside ratio exceeds one quarter", async () => {
  const width = 18;
  const height = 14;
  const raw = Buffer.alloc(width * height * 3, 30);
  for (let y = 3; y < 11; y += 1) {
    raw.fill(240, (y * width + 8) * 3, (y * width + 8) * 3 + 3);
  }
  for (const y of [5, 6, 7]) raw.fill(240, (y * width + 9) * 3, (y * width + 9) * 3 + 3);

  await assert.rejects(
    buildTightTextMask(
      await encodeRgb(raw, width, height),
      textElement("excess-fringe", { x: 4, y: 2, width: 5, height: 10 }),
      { dilationPx: 0 },
    ),
    /Text mask fringe would remove too much outside the OCR box for excess-fringe/,
  );
});

test("rejects a touching horizontal decorative rule before dilation", async () => {
  const width = 40;
  const height = 30;
  const raw = Buffer.alloc(width * height * 3, 240);
  for (let y = 10; y < 15; y += 1) {
    for (let x = 12; x < 20; x += 1) raw.fill(30, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  for (let x = 10; x < 18; x += 1) raw.fill(30, (9 * width + x) * 3, (9 * width + x) * 3 + 3);

  await assert.rejects(
    buildTightTextMask(
      await encodeRgb(raw, width, height),
      textElement("horizontal-rule", { x: 10, y: 10, width: 16, height: 10 }),
      { dilationPx: 0 },
    ),
    /Text mask fringe would capture line-like structure for horizontal-rule/,
  );
});

test("rejects a touching vertical decorative rule before dilation", async () => {
  const width = 40;
  const height = 30;
  const raw = Buffer.alloc(width * height * 3, 240);
  for (let y = 12; y < 20; y += 1) {
    for (let x = 10; x < 15; x += 1) raw.fill(30, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  for (let y = 10; y < 18; y += 1) raw.fill(30, (y * width + 9) * 3, (y * width + 9) * 3 + 3);

  await assert.rejects(
    buildTightTextMask(
      await encodeRgb(raw, width, height),
      textElement("vertical-rule", { x: 10, y: 10, width: 10, height: 16 }),
      { dilationPx: 0 },
    ),
    /Text mask fringe would capture line-like structure for vertical-rule/,
  );
});

test("preserves a nearby disconnected decorative rule", async () => {
  const width = 40;
  const height = 30;
  const raw = Buffer.alloc(width * height * 3, 240);
  for (let y = 12; y < 18; y += 1) {
    for (let x = 14; x < 17; x += 1) raw.fill(30, (y * width + x) * 3, (y * width + x) * 3 + 3);
  }
  for (let x = 10; x < 20; x += 1) raw.fill(30, (8 * width + x) * 3, (8 * width + x) * 3 + 3);
  const result = await buildTightTextMask(
    await encodeRgb(raw, width, height),
    textElement("nearby-rule", { x: 10, y: 10, width: 16, height: 10 }),
    { dilationPx: 0 },
  );
  const { data, info } = await decodeMask(result.mask);

  assert.equal(data[(8 * info.width + 14) * info.channels], 0);
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

test("models a smooth gradient inside an explicit same-surface mask", async () => {
  const width = 48;
  const height = 24;
  const rgb = Buffer.alloc(width * height * 3);
  const surface = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const value = 70 + x * 3;
      rgb.set([value, value + 5, value + 10], offset);
      if (x >= 4 && x < 44 && y >= 3 && y < 21) {
        surface[y * width + x] = 255;
      }
    }
  }
  for (let y = 9; y < 15; y += 1) {
    for (const x of [20, 21, 27, 28]) {
      rgb.set([20, 24, 28], (y * width + x) * 3);
    }
  }
  const result = await buildTightTextMask(
    await encodeRgb(rgb, width, height),
    textElement("gradient-glyph", { x: 12, y: 6, width: 24, height: 12 }),
    {
      dilationPx: 0,
      surfaceMask: await encodeMask(surface, width, height),
    },
  );
  const { data, info } = await decodeMask(result.mask);

  assert.equal(result.maskedPixels, 24);
  assert.equal(data[(11 * width + 20) * info.channels], 255);
  assert.equal(data[(11 * width + 24) * info.channels], 0);
});

test("clips adaptive text dilation to its accepted surface", async () => {
  const width = 32;
  const height = 24;
  const rgb = Buffer.alloc(width * height * 3, 240);
  const surface = Buffer.alloc(width * height);
  for (let y = 5; y < 19; y += 1) {
    for (let x = 6; x < 26; x += 1) surface[y * width + x] = 255;
  }
  rgb.set([20, 20, 20], (10 * width + 7) * 3);
  const result = await buildTightTextMask(
    await encodeRgb(rgb, width, height),
    textElement("surface-clipped", { x: 6, y: 7, width: 8, height: 8 }),
    {
      dilationPx: 3,
      surfaceMask: await encodeMask(surface, width, height),
    },
  );
  const { data, info } = await decodeMask(result.mask);

  assert.equal(data[(10 * width + 6) * info.channels], 255);
  assert.equal(data[(10 * width + 5) * info.channels], 0);
});
