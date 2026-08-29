import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import type { BBox, TextSlideElement } from "../src/contracts.js";
import { extractTextBacking } from "../src/fidelity/text-backing.js";
import type { SourceCanvas } from "../src/image/source.js";
import type { SemanticCandidate } from "../src/scene/plan.js";

type Rgb = readonly [number, number, number];

type Fixture = {
  canvas: SourceCanvas;
  candidate: SemanticCandidate;
  texts: TextSlideElement[];
  backingPixels: Uint8Array;
  glyphPixels: number[];
};

const WIDTH = 120;
const HEIGHT = 80;
const PANEL: BBox = { x: 20, y: 16, width: 80, height: 48 };

function setRgb(rgba: Buffer, index: number, color: Rgb): void {
  rgba.set(color, index * 4);
  rgba[index * 4 + 3] = 255;
}

function insideRoundedPanel(x: number, y: number, radius: number): boolean {
  const left = PANEL.x;
  const top = PANEL.y;
  const right = PANEL.x + PANEL.width;
  const bottom = PANEL.y + PANEL.height;
  const centerX = x < left + radius ? left + radius : right - radius - 1;
  const centerY = y < top + radius ? top + radius : bottom - radius - 1;
  if (x >= left + radius && x < right - radius) return true;
  if (y >= top + radius && y < bottom - radius) return true;
  const dx = x - centerX;
  const dy = y - centerY;
  return dx * dx + dy * dy <= radius * radius;
}

function textElement(id: string, bbox: BBox, text: string): TextSlideElement {
  return {
    kind: "text",
    id,
    text,
    bbox,
    rotation: 0,
    color: "FFFFFF",
    fontSizePx: 14,
    align: "left",
    zIndex: 100,
  };
}

function makeFixture(options: {
  surface?: "solid" | "gradient" | "light-texture" | "heavy-texture" | "step";
  rounded?: boolean;
  multiline?: boolean;
  adjacentIcon?: boolean;
  intersectingObject?: boolean;
  panel?: BBox;
} = {}): Fixture {
  const panel = options.panel ?? PANEL;
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  const backingPixels = new Uint8Array(WIDTH * HEIGHT);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    setRgb(rgba, index, [238, 232, 218]);
  }
  for (let y = Math.floor(panel.y); y < panel.y + panel.height; y += 1) {
    for (let x = Math.floor(panel.x); x < panel.x + panel.width; x += 1) {
      const panelPixel = options.rounded
        ? insideRoundedPanel(x, y, 9)
        : true;
      if (!panelPixel || x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
      let value = 88;
      if (options.surface === "gradient") value = 60 + Math.round((x - panel.x) * 1.15);
      if (options.surface === "light-texture") value = 100 + ((x * 7 + y * 11) % 9) - 4;
      if (options.surface === "heavy-texture") value = (x + y) % 2 === 0 ? 55 : 175;
      if (options.surface === "step") value = x < panel.x + panel.width / 2 ? 82 : 110;
      setRgb(rgba, y * WIDTH + x, [value, value + 8, value + 14]);
      backingPixels[y * WIDTH + x] = 255;
    }
  }

  if (options.adjacentIcon) {
    for (let y = 28; y < 48; y += 1) {
      for (let x = 104; x < 114; x += 1) setRgb(rgba, y * WIDTH + x, [220, 80, 35]);
    }
  }
  if (options.intersectingObject) {
    for (let y = 27; y < 53; y += 1) {
      for (let x = 88; x < 108; x += 1) setRgb(rgba, y * WIDTH + x, [224, 72, 30]);
    }
  }

  const texts = options.multiline
    ? [
        textElement("ocr-zh", { x: 34, y: 25, width: 26, height: 12 }, "中文标题"),
        textElement("ocr-en", { x: 42, y: 43, width: 38, height: 12 }, "English line"),
      ]
    : [textElement("ocr-main", { x: 40, y: 31, width: 40, height: 16 }, "Editable")];
  const glyphPixels: number[] = [];
  for (const [textIndex, text] of texts.entries()) {
    const strokes = options.surface === "step"
      ? [panel.x + panel.width / 2 - 1, panel.x + panel.width / 2]
      : textIndex === 0 && texts.length > 1
        ? [text.bbox.x + 5, text.bbox.x + 11, text.bbox.x + 17]
        : [text.bbox.x + 6, text.bbox.x + 14, text.bbox.x + 23, text.bbox.x + 31];
    for (let y = Math.floor(text.bbox.y + 2); y < text.bbox.y + text.bbox.height - 2; y += 1) {
      for (const xValue of strokes) {
        const x = Math.floor(xValue);
        if (x >= text.bbox.x + text.bbox.width) continue;
        const index = y * WIDTH + x;
        setRgb(rgba, index, [20, 24, 28]);
        glyphPixels.push(index);
      }
    }
  }

  return {
    canvas: {
      format: "png",
      width: WIDTH,
      height: HEIGHT,
      rgba,
      sourceBytes: Buffer.alloc(0),
    },
    candidate: {
      id: "backing-candidate",
      kind: "text-backing",
      nodeIds: ["backing-node"],
      bbox: panel,
      zOrder: 1,
      relations: ["opaque-relation-id"],
    },
    texts,
    backingPixels,
    glyphPixels,
  };
}

async function decodeMask(mask: Buffer): Promise<Uint8Array> {
  const { data, info } = await sharp(mask)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = new Uint8Array(info.width * info.height);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = data[index * info.channels]!;
  }
  return output;
}

async function expectAcceptedFixture(fixture: Fixture): Promise<void> {
  const originalTexts = structuredClone(fixture.texts);
  const result = await extractTextBacking(
    fixture.canvas,
    fixture.candidate,
    fixture.texts,
  );

  assert.equal(result.accepted, true, result.reason);
  assert.ok(result.asset);
  assert.ok(result.assetMask);
  assert.ok(result.repairedSource);
  assert.deepEqual(result.textNodeIds, fixture.texts.map(({ id }) => id));
  assert.deepEqual(fixture.texts, originalTexts);
  assert.ok(result.metrics.residualGlyphRatio <= 0.02);
  assert.equal(result.metrics.outsideBackingChangedPixels, 0);
  assert.ok(result.metrics.seamContrastP95 <= 8);

  const asset = await sharp(result.asset).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  assert.equal(asset.info.width, fixture.candidate.bbox.width);
  assert.equal(asset.info.height, fixture.candidate.bbox.height);
  let assetForegroundPixels = 0;
  let bakedGlyphPixels = 0;
  for (let index = 0; index < asset.info.width * asset.info.height; index += 1) {
    const offset = index * asset.info.channels;
    if (asset.data[offset + 3]! < 16) continue;
    assetForegroundPixels += 1;
    if (
      asset.data[offset] === 20 &&
      asset.data[offset + 1] === 24 &&
      asset.data[offset + 2] === 28
    ) {
      bakedGlyphPixels += 1;
    }
  }
  assert.ok(assetForegroundPixels > 0);
  assert.equal(bakedGlyphPixels, 0);

  const mask = await decodeMask(result.assetMask);
  for (let index = 0; index < mask.length; index += 1) {
    assert.equal(mask[index]! >= 16, fixture.backingPixels[index]! >= 16);
  }
  const repaired = await sharp(result.repairedSource).ensureAlpha().raw().toBuffer();
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    if (mask[index]! >= 16) continue;
    assert.deepEqual(
      repaired.subarray(index * 4, index * 4 + 4),
      fixture.canvas.rgba.subarray(index * 4, index * 4 + 4),
    );
  }
  for (const index of fixture.glyphPixels) {
    const before = fixture.canvas.rgba[index * 4]!;
    const after = repaired[index * 4]!;
    assert.ok(Math.abs(after - before) >= 24, `glyph pixel ${index} was not removed`);
  }
}

for (const [name, fixture] of [
  ["solid backing", makeFixture()],
  ["gradient backing", makeFixture({ surface: "gradient" })],
  ["lightly textured backing", makeFixture({ surface: "light-texture" })],
  ["rounded backing", makeFixture({ rounded: true })],
  ["multiline Chinese and English backing", makeFixture({ multiline: true })],
  ["backing beside an independent icon", makeFixture({ adjacentIcon: true })],
] as const) {
  test(`extracts complete ${name} and keeps its text editable`, async () => {
    await expectAcceptedFixture(fixture);
  });
}

test("is invariant to audit-only candidate and text naming", async () => {
  const left = makeFixture({ surface: "gradient" });
  const right = makeFixture({ surface: "gradient" });
  right.candidate.id = "renamed-with-misleading-icon-words";
  right.candidate.nodeIds = ["different-node-name"];
  right.candidate.relations = ["different-opaque-relation"];
  right.texts[0]!.text = "完全不同的标签";
  right.texts[0]!.id = "renamed-text";

  const [leftResult, rightResult] = await Promise.all([
    extractTextBacking(left.canvas, left.candidate, left.texts),
    extractTextBacking(right.canvas, right.candidate, right.texts),
  ]);

  assert.equal(leftResult.accepted, true);
  assert.equal(rightResult.accepted, true);
  assert.deepEqual(leftResult.asset, rightResult.asset);
  assert.deepEqual(leftResult.assetMask, rightResult.assetMask);
  assert.deepEqual(leftResult.repairedSource, rightResult.repairedSource);
  assert.deepEqual(leftResult.metrics, rightResult.metrics);
});

test("unions only carried text masks and leaves separate OCR pixels untouched", async () => {
  const fixture = makeFixture();
  const unrelated = textElement(
    "separate-ocr",
    { x: 2, y: 4, width: 10, height: 10 },
    "separate",
  );
  fixture.texts.push(unrelated);
  const separateGlyph = 8 * WIDTH + 6;
  setRgb(fixture.canvas.rgba, separateGlyph, [18, 22, 26]);

  const result = await extractTextBacking(
    fixture.canvas,
    fixture.candidate,
    fixture.texts,
  );
  assert.equal(result.accepted, true);
  assert.ok(result.repairedSource);
  const repaired = await sharp(result.repairedSource).ensureAlpha().raw().toBuffer();

  assert.deepEqual(result.textNodeIds, ["ocr-main"]);
  assert.deepEqual(
    repaired.subarray(separateGlyph * 4, separateGlyph * 4 + 4),
    fixture.canvas.rgba.subarray(separateGlyph * 4, separateGlyph * 4 + 4),
  );
});

async function expectAtomicRejection(
  fixture: Fixture,
  reason: "backing_mask_invalid" | "glyph_residue" | "repair_seam" | "surface_unstable",
): Promise<void> {
  const result = await extractTextBacking(
    fixture.canvas,
    fixture.candidate,
    fixture.texts,
  );
  assert.equal(result.accepted, false, JSON.stringify(result.metrics));
  assert.equal(result.reason, reason);
  assert.equal(result.asset, undefined);
  assert.equal(result.assetMask, undefined);
  assert.equal(result.repairedSource, undefined);
}

test("atomically rejects a heavy-texture backing", async () => {
  await expectAtomicRejection(
    makeFixture({ surface: "heavy-texture" }),
    "surface_unstable",
  );
});

test("atomically rejects an intersecting unrelated object", async () => {
  await expectAtomicRejection(
    makeFixture({ intersectingObject: true }),
    "surface_unstable",
  );
});

test("atomically rejects an incomplete backing contour at the canvas border", async () => {
  const fixture = makeFixture({ panel: { x: 0, y: 16, width: 74, height: 48 } });
  fixture.candidate.bbox = { x: 0, y: 16, width: 74, height: 48 };
  await expectAtomicRejection(fixture, "backing_mask_invalid");
});

test("atomically rejects an unrelated OCR box intersecting the backing", async () => {
  const fixture = makeFixture();
  fixture.texts.push(
    textElement("unrelated", { x: 94, y: 30, width: 18, height: 14 }, "outside"),
  );
  await expectAtomicRejection(fixture, "backing_mask_invalid");
});

test("atomically rejects a visible repair seam", async () => {
  await expectAtomicRejection(
    makeFixture({ surface: "step" }),
    "repair_seam",
  );
});
