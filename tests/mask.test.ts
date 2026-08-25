import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import sharp from "sharp";

import type { SlideElement } from "../src/contracts.js";
import { buildRemovalMask } from "../src/image/mask.js";
import { planSlide } from "../src/planner.js";
import { parseQwenVisionContent } from "../src/providers/qwen-vision.js";

async function maskPixels(mask: Buffer) {
  return sharp(mask).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

function pixel(data: Buffer, width: number, x: number, y: number): number {
  return data[(y * width + x) * 3]!;
}

test("renders an exact 1280 by 720 merged mask with kind-specific padding", async () => {
  const elements: SlideElement[] = [
    {
      kind: "text",
      id: "text-1",
      text: "Title",
      bbox: { x: 100, y: 100, width: 40, height: 20 },
      rotation: 0,
      color: "23394D",
      fontSizePx: 18,
      align: "left",
      zIndex: 3,
    },
    {
      kind: "asset",
      id: "asset-1",
      label: "icon",
      bbox: { x: 200, y: 200, width: 30, height: 30 },
      extraction: "transparent",
      assetPath: "assets/icon.png",
      zIndex: 2,
    },
    {
      kind: "shape",
      id: "shape-1",
      label: "rounded mask shape",
      shape: "roundRect",
      bbox: { x: 300, y: 300, width: 50, height: 40 },
      fillColor: "FFFFFF",
      strokeColor: "23394D",
      strokeWidthPx: 1,
      cornerRadiusPx: 8,
      zIndex: 1,
    },
  ];

  const mask = await buildRemovalMask(1280, 720, elements);
  const { data, info } = await maskPixels(mask);

  assert.equal(info.width, 1280);
  assert.equal(info.height, 720);
  assert.equal(pixel(data, info.width, 10, 10), 0);
  assert.equal(pixel(data, info.width, 96, 100), 255);
  assert.equal(pixel(data, info.width, 95, 100), 0);
  assert.equal(pixel(data, info.width, 194, 210), 255);
  assert.equal(pixel(data, info.width, 193, 210), 0);
  assert.equal(pixel(data, info.width, 298, 320), 255);
  assert.equal(pixel(data, info.width, 297, 320), 0);
});

test("clips padded target bounds at every canvas edge", async () => {
  const elements: SlideElement[] = [
    {
      kind: "asset",
      id: "edge-asset",
      label: "edge icon",
      bbox: { x: 0, y: 0, width: 8, height: 8 },
      extraction: "rectangular",
      assetPath: "assets/edge.png",
      zIndex: 1,
    },
    {
      kind: "text",
      id: "edge-text",
      text: "edge",
      bbox: { x: 1272, y: 712, width: 8, height: 8 },
      rotation: 0,
      color: "23394D",
      fontSizePx: 14,
      align: "left",
      zIndex: 2,
    },
  ];

  const mask = await buildRemovalMask(1280, 720, elements);
  const { data, info } = await maskPixels(mask);

  assert.equal(info.width, 1280);
  assert.equal(info.height, 720);
  assert.equal(pixel(data, info.width, 0, 0), 255);
  assert.equal(pixel(data, info.width, 13, 7), 255);
  assert.equal(pixel(data, info.width, 14, 7), 0);
  assert.equal(pixel(data, info.width, 1279, 719), 255);
  assert.equal(pixel(data, info.width, 1268, 715), 255);
  assert.equal(pixel(data, info.width, 1267, 715), 0);
});

test("lets the SVG viewport naturally clip expanded rounded rectangles at an edge", async () => {
  const element: SlideElement = {
    kind: "shape",
    id: "edge-round-rect",
    label: "edge rounded rectangle",
    shape: "roundRect",
    bbox: { x: 0, y: 0, width: 40, height: 30 },
    fillColor: "FFFFFF",
    strokeColor: "23394D",
    strokeWidthPx: 1,
    cornerRadiusPx: 2,
    zIndex: 1,
  };

  const mask = await buildRemovalMask(1280, 720, [element]);
  const expected = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="black"/><rect x="-2" y="-2" width="44" height="34" rx="4" fill="white"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const actualPixels = await maskPixels(mask);
  const expectedPixels = await maskPixels(expected);

  assert.equal(pixel(actualPixels.data, actualPixels.info.width, 0, 0), 255);
  assert.deepEqual(actualPixels.data, expectedPixels.data);
});

test("masks the inspected slide 7 bars and separated right panels without bridging their gap", async () => {
  const rawVision = JSON.parse(
    await readFile(resolve("tests/fixtures/qwen-vision-slide-07.json"), "utf8"),
  ) as { choices: Array<{ message: { content: string } }> };
  const vision = parseQwenVisionContent(
    rawVision.choices[0]!.message.content,
  );
  const manifest = planSlide({ lines: [] }, vision);
  const shapes = manifest.elements.filter((element) => element.kind === "shape");
  const mask = await buildRemovalMask(1280, 720, shapes);
  const { data, info } = await maskPixels(mask);

  assert.equal(shapes.length, 8);
  assert.equal(pixel(data, info.width, 18, 40), 255);
  assert.equal(pixel(data, info.width, 136, 180), 255);
  assert.equal(pixel(data, info.width, 44, 650), 255);
  assert.equal(pixel(data, info.width, 1000, 300), 255);
  assert.equal(pixel(data, info.width, 1000, 500), 255);
  assert.equal(pixel(data, info.width, 1000, 419), 0);
});
