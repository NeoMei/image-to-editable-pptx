import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import type { TextSlideElement } from "../src/contracts.js";
import { extractTextBacking } from "../src/fidelity/text-backing.js";
import type { SemanticCandidate } from "../src/scene/plan.js";

async function makeFixture(extraSvg = "") {
  const template = await readFile(join(process.cwd(), "tests/fixtures/semantic/white-text-backing.svg"), "utf8");
  const svg = Buffer.from(template.replace("</svg>", `${extraSvg}</svg>`));
  const sourceBytes = await sharp(svg).png().toBuffer();
  const rgba = await sharp(sourceBytes).ensureAlpha().raw().toBuffer();
  const text: TextSlideElement = {
    kind: "text", id: "ocr-label", text: "HOST FIRST",
    bbox: { x: 825, y: 326, width: 190, height: 27 },
    rotation: 0, color: "FFFFFF", fontSizePx: 32, align: "left", zIndex: 2,
  };
  const candidate: SemanticCandidate = {
    id: "blue-panel", kind: "text-backing", nodeIds: ["panel"],
    bbox: { x: 790, y: 292, width: 374, height: 92 },
    zOrder: 1, relations: [], carriedTextIds: [text.id],
  };

  return {
    canvas: { width: 1280, height: 720, format: "png" as const, rgba, sourceBytes },
    candidate,
    texts: [text],
  };
}

// Release-gate geometry: white glyphs resemble the cream canvas enough that
// generic foreground extraction can mistake them for transparent cutouts.
test("repairs white glyph interiors into an opaque blue backing without filling its rounded corners", async () => {
  const fixture = await makeFixture();
  const original = Buffer.from(fixture.canvas.rgba);
  const result = await extractTextBacking(fixture.canvas, fixture.candidate, fixture.texts);

  assert.equal(result.accepted, true, result.reason);
  assert.ok(result.asset);
  assert.ok(result.assetMask);
  assert.ok(result.repairedSource);
  assert.deepEqual(fixture.canvas.rgba, original, "extraction must not mutate source pixels");
  const asset = await sharp(result.asset).ensureAlpha().raw().toBuffer();
  const mask = await sharp(result.assetMask).removeAlpha().greyscale().raw().toBuffer();
  const repaired = await sharp(result.repairedSource).ensureAlpha().raw().toBuffer();
  let glyphPixels = 0;
  let transparentGlyphPixels = 0;
  let nonBluePixels = 0;
  for (let y = 326; y < 353; y += 1) {
    for (let x = 825; x < 1015; x += 1) {
      const sourceIndex = y * 1280 + x;
      const offset = ((y - 292) * 374 + x - 790) * 4;
      if (asset[offset + 3] !== 255 || mask[sourceIndex] !== 255) transparentGlyphPixels += 1;
      for (const [channel, expected] of [35, 93, 142].entries()) {
        if (Math.abs(asset[offset + channel]! - expected) > 2) nonBluePixels += 1;
      }
      if (original[sourceIndex * 4]! > 240 && original[sourceIndex * 4 + 1]! > 240) {
        glyphPixels += 1;
      }
    }
  }
  assert.ok(glyphPixels > 500, "fixture must contain real solid white glyph interiors");
  assert.equal(transparentGlyphPixels, 0, "backing must not contain glyph-shaped alpha holes");
  assert.equal(nonBluePixels, 0, "backing must not retain glyph colors");
  for (const [x, y] of [[0, 0], [373, 0], [0, 91], [373, 91]]) {
    assert.equal(asset[(y! * 374 + x!) * 4 + 3], 0, "rounded exterior must stay transparent");
  }
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]! >= 16) continue;
    assert.deepEqual(repaired.subarray(index * 4, index * 4 + 4), original.subarray(index * 4, index * 4 + 4));
  }
  assert.equal(result.metrics.outsideBackingChangedPixels, 0);
  assert.ok(result.metrics.residualGlyphRatio <= 0.02);
  assert.ok(result.metrics.seamContrastP95 <= 8);
});

test("preserves an unrelated enclosed cutout outside the carried text", async () => {
  const fixture = await makeFixture('<circle cx="1110" cy="336" r="10" fill="#f7f4ed"/>');
  const result = await extractTextBacking(fixture.canvas, fixture.candidate, fixture.texts);
  assert.equal(result.accepted, true, result.reason);
  assert.ok(result.asset);
  const asset = await sharp(result.asset).ensureAlpha().raw().toBuffer();
  assert.equal(asset[((336 - 292) * 374 + 1110 - 790) * 4 + 3], 0);
});

test("atomically rejects carried text whose missing surface connects to the exterior contour", async () => {
  const fixture = await makeFixture('<rect x="828" y="292" width="3" height="58" fill="#f7f4ed"/>');
  const original = Buffer.from(fixture.canvas.rgba);
  const result = await extractTextBacking(fixture.canvas, fixture.candidate, fixture.texts);
  assert.equal(result.accepted, false, "a contour-connected hole cannot safely be restored as glyph backing");
  assert.equal(result.asset, undefined);
  assert.equal(result.assetMask, undefined);
  assert.equal(result.repairedSource, undefined);
  assert.deepEqual(fixture.canvas.rgba, original);
});

test("atomically rejects an ambiguous small cutout inside the carried OCR box", async () => {
  const fixture = await makeFixture('<circle cx="1010" cy="330" r="2" fill="#f7f4ed"/>');
  const original = Buffer.from(fixture.canvas.rgba);
  const result = await extractTextBacking(fixture.canvas, fixture.candidate, fixture.texts);
  assert.equal(result.accepted, false, "OCR box membership alone cannot attribute an unrelated cutout to text");
  assert.equal(result.asset, undefined);
  assert.equal(result.assetMask, undefined);
  assert.equal(result.repairedSource, undefined);
  assert.deepEqual(fixture.canvas.rgba, original);
});
