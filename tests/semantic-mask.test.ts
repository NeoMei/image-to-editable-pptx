import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import type { BBox } from "../src/contracts.js";
import type { SourceCanvas } from "../src/image/source.js";
import {
  chooseSemanticMask,
  deriveSemanticMasks,
  type MaskCandidate,
} from "../src/image/semantic-mask.js";
import type { SemanticCandidate } from "../src/scene/plan.js";

type Rgba = readonly [number, number, number, number];

function solidCanvas(
  width: number,
  height: number,
  background: Rgba = [247, 243, 233, 255],
  format: SourceCanvas["format"] = "png",
): SourceCanvas {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba.set(background, index * 4);
  }
  return { format, width, height, rgba, sourceBytes: Buffer.alloc(0) };
}

function paintRect(canvas: SourceCanvas, bbox: BBox, color: Rgba): void {
  const left = Math.max(0, Math.floor(bbox.x));
  const top = Math.max(0, Math.floor(bbox.y));
  const right = Math.min(canvas.width, Math.ceil(bbox.x + bbox.width));
  const bottom = Math.min(canvas.height, Math.ceil(bbox.y + bbox.height));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      canvas.rgba.set(color, (y * canvas.width + x) * 4);
    }
  }
}

function semanticCandidate(
  id: string,
  bbox: BBox,
  kind: SemanticCandidate["kind"] = "foreground-object",
): SemanticCandidate {
  return {
    id,
    kind,
    nodeIds: [id],
    bbox,
    zOrder: 1,
    relations: [],
    carriedTextIds: [],
  };
}

async function alphaOf(mask: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const decoded = await sharp(mask)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: decoded.data, width: decoded.info.width, height: decoded.info.height };
}

async function canvasAlpha(
  mask: MaskCandidate,
  canvas: { width: number; height: number },
): Promise<Uint8Array> {
  const decoded = await alphaOf(mask.mask);
  const projected = new Uint8Array(canvas.width * canvas.height);
  const left = Math.floor(mask.bbox.x);
  const top = Math.floor(mask.bbox.y);
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const targetX = left + x;
      const targetY = top + y;
      if (targetX < 0 || targetX >= canvas.width || targetY < 0 || targetY >= canvas.height) {
        continue;
      }
      projected[targetY * canvas.width + targetX] =
        decoded.data[(y * decoded.width + x) * 4 + 3]!;
    }
  }
  return projected;
}

async function emptyTextMask(width: number, height: number): Promise<Buffer> {
  return sharp(Buffer.alloc(width * height), {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toBuffer();
}

test("keeps adjacent and touching independent candidates pixel-disjoint", async () => {
  const canvas = solidCanvas(96, 64);
  paintRect(canvas, { x: 24, y: 22, width: 12, height: 20 }, [35, 57, 77, 255]);
  paintRect(canvas, { x: 36, y: 22, width: 12, height: 20 }, [230, 93, 22, 255]);
  const textMask = await emptyTextMask(canvas.width, canvas.height);

  const [leftMasks, rightMasks] = await Promise.all([
    deriveSemanticMasks(canvas, semanticCandidate("left", { x: 24, y: 22, width: 12, height: 20 })),
    deriveSemanticMasks(canvas, semanticCandidate("right", { x: 36, y: 22, width: 12, height: 20 })),
  ]);
  const left = chooseSemanticMask(leftMasks, textMask);
  const right = chooseSemanticMask(rightMasks, textMask);

  assert.ok(left);
  assert.ok(right);
  const [leftAlpha, rightAlpha] = await Promise.all([
    canvasAlpha(left, canvas),
    canvasAlpha(right, canvas),
  ]);
  for (let index = 0; index < leftAlpha.length; index += 1) {
    assert.equal(leftAlpha[index]! > 0 && rightAlpha[index]! > 0, false);
  }
  assert.ok(leftAlpha[30 * canvas.width + 30]! > 0);
  assert.ok(rightAlpha[30 * canvas.width + 42]! > 0);
});

test("assigns fractional touching bboxes by half-open pixel-center ownership", async () => {
  const canvas = solidCanvas(64, 64);
  paintRect(canvas, { x: 10, y: 22, width: 21, height: 17 }, [35, 57, 77, 255]);
  const textMask = await emptyTextMask(canvas.width, canvas.height);
  const leftBox = { x: 10.2, y: 22.2, width: 10.4, height: 16.4 };
  const rightBox = { x: 20.6, y: 22.2, width: 10.4, height: 16.4 };

  const [leftMasks, rightMasks] = await Promise.all([
    deriveSemanticMasks(canvas, semanticCandidate("fractional-left", leftBox)),
    deriveSemanticMasks(canvas, semanticCandidate("fractional-right", rightBox)),
  ]);
  const left = chooseSemanticMask(leftMasks, textMask);
  const right = chooseSemanticMask(rightMasks, textMask);

  assert.ok(left);
  assert.ok(right);
  const [leftAlpha, rightAlpha] = await Promise.all([
    canvasAlpha(left, canvas),
    canvasAlpha(right, canvas),
  ]);
  for (let index = 0; index < leftAlpha.length; index += 1) {
    assert.equal(leftAlpha[index]! > 0 && rightAlpha[index]! > 0, false);
  }
  assert.ok(leftAlpha[30 * canvas.width + 20]! > 0);
  assert.equal(rightAlpha[30 * canvas.width + 20], 0);
  assert.ok(rightAlpha[30 * canvas.width + 21]! > 0);
});

test("offers a dominant connected-component proposal when a loose bbox includes OCR noise", async () => {
  const canvas = solidCanvas(96, 64);
  paintRect(canvas, { x: 24, y: 22, width: 14, height: 20 }, [35, 57, 77, 255]);
  paintRect(canvas, { x: 44, y: 28, width: 4, height: 4 }, [35, 57, 77, 255]);
  const text = Buffer.alloc(canvas.width * canvas.height);
  text[29 * canvas.width + 45] = 255;
  const textMask = await sharp(text, {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  })
    .png()
    .toBuffer();

  const masks = await deriveSemanticMasks(
    canvas,
    semanticCandidate("loose", { x: 22, y: 20, width: 28, height: 24 }),
  );
  const chosen = chooseSemanticMask(masks, textMask);

  assert.ok(chosen);
  const alpha = await canvasAlpha(chosen, canvas);
  assert.ok(alpha[30 * canvas.width + 30]! > 0);
  assert.equal(alpha[29 * canvas.width + 45], 0);
  assert.equal(chosen.metrics.connectedComponents, 1);
  assert.equal(chosen.metrics.completeness, 1);
});

test("keeps near integral details while stripping far fragments in semantic masks", async () => {
  const canvas = solidCanvas(72, 56);
  paintRect(canvas, { x: 12, y: 16, width: 12, height: 12 }, [35, 57, 77, 255]);
  paintRect(canvas, { x: 27, y: 18, width: 3, height: 3 }, [35, 57, 77, 255]);
  paintRect(canvas, { x: 40, y: 30, width: 4, height: 4 }, [35, 57, 77, 255]);
  const chosen = chooseSemanticMask(
    await deriveSemanticMasks(
      canvas,
      semanticCandidate("icon", { x: 12, y: 16, width: 32, height: 18 }),
    ),
    await emptyTextMask(72, 56),
  );

  assert.ok(chosen);
  const alpha = await canvasAlpha(chosen, canvas);
  assert.ok(alpha[22 * canvas.width + 18]! > 0);
  assert.ok(alpha[19 * canvas.width + 28]! > 0);
  assert.equal(alpha[32 * canvas.width + 42], 0);
  assert.equal(chosen.metrics.connectedComponents, 2);
});

test("retains a connector inside an explicitly planned compound", async () => {
  const canvas = solidCanvas(128, 80);
  paintRect(canvas, { x: 24, y: 24, width: 20, height: 24 }, [35, 57, 77, 255]);
  paintRect(canvas, { x: 76, y: 24, width: 20, height: 24 }, [35, 57, 77, 255]);
  paintRect(canvas, { x: 44, y: 35, width: 32, height: 2 }, [35, 57, 77, 255]);
  const masks = await deriveSemanticMasks(
    canvas,
    semanticCandidate("compound", { x: 24, y: 24, width: 72, height: 24 }, "compound-group"),
  );
  const chosen = chooseSemanticMask(masks, await emptyTextMask(128, 80));

  assert.ok(chosen);
  const alpha = await canvasAlpha(chosen, canvas);
  assert.ok(alpha[35 * canvas.width + 60]! > 0);
  assert.equal(chosen.metrics.connectedComponents, 1);
});

test("scales bounded crop padding with the shorter canvas side", async () => {
  const small = solidCanvas(128, 64);
  const large = solidCanvas(512, 256);
  paintRect(small, { x: 48, y: 24, width: 16, height: 16 }, [35, 57, 77, 255]);
  paintRect(large, { x: 192, y: 96, width: 64, height: 64 }, [35, 57, 77, 255]);

  const [smallMasks, largeMasks] = await Promise.all([
    deriveSemanticMasks(small, semanticCandidate("small", { x: 48, y: 24, width: 16, height: 16 })),
    deriveSemanticMasks(large, semanticCandidate("large", { x: 192, y: 96, width: 64, height: 64 })),
  ]);
  const smallPadding = Math.max(...smallMasks.map((mask) => mask.cropPaddingPx));
  const largePadding = Math.max(...largeMasks.map((mask) => mask.cropPaddingPx));

  assert.ok(smallMasks.length > 0);
  assert.ok(largeMasks.length > 0);
  assert.equal(largePadding, smallPadding * 4);
});

test("preserves a transparent-looking interior and a gradient foreground", async () => {
  const canvas = solidCanvas(96, 64);
  for (let y = 18; y < 46; y += 1) {
    for (let x = 30; x < 66; x += 1) {
      const border = x < 34 || x >= 62 || y < 22 || y >= 42;
      if (!border) continue;
      const red = 30 + Math.round(((x - 30) / 35) * 150);
      canvas.rgba.set([red, 70, 150, 255], (y * canvas.width + x) * 4);
    }
  }
  const chosen = chooseSemanticMask(
    await deriveSemanticMasks(
      canvas,
      semanticCandidate("gradient-ring", { x: 30, y: 18, width: 36, height: 28 }),
    ),
    await emptyTextMask(96, 64),
  );

  assert.ok(chosen);
  const alpha = await canvasAlpha(chosen, canvas);
  assert.equal(alpha[32 * canvas.width + 48], 0);
  assert.ok(alpha[20 * canvas.width + 32]! > 0);
  const decoded = await alphaOf(chosen.mask);
  const opaqueReds: number[] = [];
  for (let index = 0; index < decoded.width * decoded.height; index += 1) {
    if (decoded.data[index * 4 + 3] === 255) opaqueReds.push(decoded.data[index * 4]!);
  }
  assert.ok(Math.max(...opaqueReds) - Math.min(...opaqueReds) > 100);
});

test("extracts a foreground object from a smooth gradient background", async () => {
  const canvas = solidCanvas(96, 64);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const channel = 130 + Math.round((x / (canvas.width - 1)) * 110);
      canvas.rgba.set([channel, channel, channel, 255], (y * canvas.width + x) * 4);
    }
  }
  paintRect(canvas, { x: 34, y: 20, width: 28, height: 24 }, [25, 55, 90, 255]);

  const chosen = chooseSemanticMask(
    await deriveSemanticMasks(
      canvas,
      semanticCandidate("gradient-surface", { x: 34, y: 20, width: 28, height: 24 }),
    ),
    await emptyTextMask(96, 64),
  );

  assert.ok(chosen);
  const alpha = await canvasAlpha(chosen, canvas);
  assert.equal(alpha[18 * canvas.width + 32], 0);
  assert.equal(alpha[30 * canvas.width + 48], 255);
});

test("keeps decontaminated soft alpha around antialiased outlines", async () => {
  const canvas = solidCanvas(64, 64);
  paintRect(canvas, { x: 20, y: 20, width: 24, height: 24 }, [35, 57, 77, 255]);
  const blended: Rgba = [141, 150, 155, 255];
  for (let x = 20; x < 44; x += 1) {
    canvas.rgba.set(blended, (20 * canvas.width + x) * 4);
    canvas.rgba.set(blended, (43 * canvas.width + x) * 4);
  }
  for (let y = 20; y < 44; y += 1) {
    canvas.rgba.set(blended, (y * canvas.width + 20) * 4);
    canvas.rgba.set(blended, (y * canvas.width + 43) * 4);
  }
  const chosen = chooseSemanticMask(
    await deriveSemanticMasks(
      canvas,
      semanticCandidate("antialiased", { x: 20, y: 20, width: 24, height: 24 }),
    ),
    await emptyTextMask(64, 64),
  );

  assert.ok(chosen);
  const decoded = await alphaOf(chosen.mask);
  const localX = 20 - Math.floor(chosen.bbox.x);
  const localY = 30 - Math.floor(chosen.bbox.y);
  const offset = (localY * decoded.width + localX) * 4;
  assert.ok(decoded.data[offset + 3]! > 0 && decoded.data[offset + 3]! < 255);
  assert.ok(decoded.data[offset]! < blended[0]);
  assert.ok(chosen.metrics.antialiasedEdgeRatio > 0);
});

test("accepts bounded JPEG ringing without changing strict safety gates", async () => {
  const pngCanvas = solidCanvas(128, 96);
  paintRect(pngCanvas, { x: 40, y: 28, width: 48, height: 40 }, [35, 57, 77, 255]);
  const jpegBytes = await sharp(pngCanvas.rgba, {
    raw: { width: pngCanvas.width, height: pngCanvas.height, channels: 4 },
  })
    .jpeg({ quality: 68 })
    .toBuffer();
  const decoded = await sharp(jpegBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const jpegCanvas: SourceCanvas = {
    format: "jpeg",
    width: decoded.info.width,
    height: decoded.info.height,
    rgba: decoded.data,
    sourceBytes: jpegBytes,
  };
  const masks = await deriveSemanticMasks(
    jpegCanvas,
    semanticCandidate("jpeg-object", { x: 40, y: 28, width: 48, height: 40 }),
  );
  assert.ok(masks.length > 0);

  const overlappingText = Buffer.alloc(jpegCanvas.width * jpegCanvas.height);
  overlappingText[48 * jpegCanvas.width + 64] = 255;
  const textMask = await sharp(overlappingText, {
    raw: { width: jpegCanvas.width, height: jpegCanvas.height, channels: 1 },
  })
    .png()
    .toBuffer();
  assert.equal(chooseSemanticMask(masks, textMask), undefined);

  const unsafeBorder = masks.map((mask) => ({
    ...mask,
    metrics: { ...mask.metrics, opaqueBorderRatio: 0.021 },
  }));
  assert.equal(
    chooseSemanticMask(unsafeBorder, await emptyTextMask(128, 96)),
    undefined,
  );

  const borderRgba = Buffer.alloc(8 * 8 * 4);
  for (let x = 0; x < 8; x += 1) {
    borderRgba.set([35, 57, 77, 255], x * 4);
  }
  const forgedSafeMetrics: MaskCandidate = {
    bbox: { x: 20, y: 20, width: 8, height: 8 },
    mask: await sharp(borderRgba, { raw: { width: 8, height: 8, channels: 4 } })
      .png()
      .toBuffer(),
    cropPaddingPx: 2,
    metrics: {
      foregroundRatio: 0.125,
      opaqueBorderRatio: 0,
      antialiasedEdgeRatio: 0,
      connectedComponents: 1,
      completeness: 1,
    },
  };
  assert.equal(
    chooseSemanticMask([forgedSafeMetrics], await emptyTextMask(128, 96)),
    undefined,
  );
});

test("rejects an incomplete crop that remains opaque at the canvas edge", async () => {
  const canvas = solidCanvas(96, 64);
  paintRect(canvas, { x: 0, y: 18, width: 24, height: 28 }, [35, 57, 77, 255]);

  const masks = await deriveSemanticMasks(
    canvas,
    semanticCandidate("clipped", { x: 0, y: 18, width: 24, height: 28 }),
  );

  assert.equal(masks.length, 0);
});

test("ranks completeness before compactness and rejects every unrelated OCR overlap", async () => {
  const makeMask = async (bbox: BBox, alphaAtCenter = true): Promise<Buffer> => {
    const width = Math.ceil(bbox.width);
    const height = Math.ceil(bbox.height);
    const rgba = Buffer.alloc(width * height * 4);
    if (alphaAtCenter) {
      const offset = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
      rgba.set([35, 57, 77, 255], offset);
    }
    return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  };
  const lessComplete: MaskCandidate = {
    bbox: { x: 2, y: 2, width: 5, height: 5 },
    mask: await makeMask({ x: 2, y: 2, width: 5, height: 5 }),
    cropPaddingPx: 1,
    metrics: {
      foregroundRatio: 0.9,
      opaqueBorderRatio: 0,
      antialiasedEdgeRatio: 0,
      connectedComponents: 1,
      completeness: 0.9,
    },
  };
  const complete: MaskCandidate = {
    bbox: { x: 1, y: 1, width: 7, height: 7 },
    mask: await makeMask({ x: 1, y: 1, width: 7, height: 7 }),
    cropPaddingPx: 2,
    metrics: {
      foregroundRatio: 0.2,
      opaqueBorderRatio: 0.01,
      antialiasedEdgeRatio: 0,
      connectedComponents: 1,
      completeness: 1,
    },
  };
  const clear = await emptyTextMask(12, 12);
  assert.equal(chooseSemanticMask([lessComplete, complete], clear), complete);

  const text = Buffer.alloc(12 * 12);
  text[4 * 12 + 4] = 255;
  const overlapping = await sharp(text, { raw: { width: 12, height: 12, channels: 1 } })
    .png()
    .toBuffer();
  assert.equal(chooseSemanticMask([lessComplete, complete], overlapping), undefined);
});
