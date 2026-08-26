import sharp from "sharp";

import type { SlideManifest, TextSlideElement } from "../contracts.js";

export const TEXT_SPAN_TOLERANCE_PX = 48;
export const TEXT_ANCHOR_TOLERANCE_PX = 12;
export const TEXT_FOREGROUND_COLOR_DISTANCE = 90;
export const TRACKED_TEXT_SCAN_SLACK_PX = 16;

type ForegroundBounds = {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  pixels: number;
};

export type TextSpanEvidence = {
  method: string;
  tolerance: {
    spanPx: number;
    anchorPx: number;
  };
  passed: boolean;
  passedCount: number;
  total: number;
  rows: Array<{
    id: string;
    text: string;
    source: ForegroundBounds;
    render: ForegroundBounds;
    spanDelta: number;
    anchorDelta: number | null;
    passed: boolean;
  }>;
};

type RawRgbImage = {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
};

async function decodeRgb(
  image: Buffer,
  canvas: SlideManifest["canvas"],
): Promise<RawRgbImage> {
  const decoded = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== canvas.width || decoded.info.height !== canvas.height) {
    throw new Error(
      `Text-span image must be ${canvas.width}x${canvas.height}; received ${decoded.info.width}x${decoded.info.height}`,
    );
  }
  return {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
  };
}

function parseRgb(color: string): readonly [number, number, number] {
  if (!/^[0-9a-f]{6}$/i.test(color)) {
    throw new Error(`Text color must be a six-digit RGB value: ${color}`);
  }
  return [
    Number.parseInt(color.slice(0, 2), 16),
    Number.parseInt(color.slice(2, 4), 16),
    Number.parseInt(color.slice(4, 6), 16),
  ];
}

function foregroundBounds(
  image: RawRgbImage,
  element: TextSlideElement,
): ForegroundBounds {
  const [red, green, blue] = parseRgb(element.color);
  const left = Math.max(0, Math.floor(element.bbox.x));
  const top = Math.max(0, Math.floor(element.bbox.y));
  const right = Math.min(
    image.width,
    Math.ceil(element.bbox.x + element.bbox.width + TRACKED_TEXT_SCAN_SLACK_PX),
  );
  const bottom = Math.min(
    image.height,
    Math.ceil(element.bbox.y + element.bbox.height),
  );
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let pixels = 0;

  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * image.width + x) * image.channels;
      const distance = Math.hypot(
        image.data[index]! - red,
        image.data[index + 1]! - green,
        image.data[index + 2]! - blue,
      );
      if (distance > TEXT_FOREGROUND_COLOR_DISTANCE) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels += 1;
    }
  }

  if (pixels === 0) {
    return { x: null, y: null, width: 0, height: 0, pixels: 0 };
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    pixels,
  };
}

export async function measureTextSpanAcceptance(
  sourceImage: Buffer,
  renderedImage: Buffer,
  manifest: SlideManifest,
): Promise<TextSpanEvidence> {
  const [source, render] = await Promise.all([
    decodeRgb(sourceImage, manifest.canvas),
    decodeRgb(renderedImage, manifest.canvas),
  ]);
  const textElements = manifest.elements.filter(
    (element): element is TextSlideElement => element.kind === "text",
  );
  const rows = textElements.map((element) => {
    const sourceBounds = foregroundBounds(source, element);
    const renderBounds = foregroundBounds(render, element);
    const spanDelta = renderBounds.width - sourceBounds.width;
    const anchorDelta =
      sourceBounds.x === null || renderBounds.x === null
        ? null
        : renderBounds.x - sourceBounds.x;
    const passed =
      sourceBounds.pixels > 0 &&
      renderBounds.pixels > 0 &&
      Math.abs(spanDelta) <= TEXT_SPAN_TOLERANCE_PX &&
      anchorDelta !== null &&
      Math.abs(anchorDelta) <= TEXT_ANCHOR_TOLERANCE_PX;
    return {
      id: element.id,
      text: element.text,
      source: sourceBounds,
      render: renderBounds,
      spanDelta,
      anchorDelta,
      passed,
    };
  });
  const passedCount = rows.filter((row) => row.passed).length;
  return {
    method:
      "text-color foreground bounds constrained to each manifest text box plus tracked-text scan slack",
    tolerance: {
      spanPx: TEXT_SPAN_TOLERANCE_PX,
      anchorPx: TEXT_ANCHOR_TOLERANCE_PX,
    },
    passed: rows.length > 0 && passedCount === rows.length,
    passedCount,
    total: rows.length,
    rows,
  };
}
