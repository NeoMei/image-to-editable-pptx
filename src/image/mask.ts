import sharp from "sharp";

import type { SlideElement } from "../contracts.js";

type ElementKind = SlideElement["kind"];

export type RemovalMaskPadding = number | Partial<Record<ElementKind, number>>;

export const DEFAULT_REMOVAL_MASK_PADDING_PX: Readonly<Record<ElementKind, number>> = {
  text: 4,
  asset: 6,
  shape: 2,
};

function paddingFor(kind: ElementKind, paddingPx?: RemovalMaskPadding): number {
  const padding =
    typeof paddingPx === "number"
      ? paddingPx
      : (paddingPx?.[kind] ?? DEFAULT_REMOVAL_MASK_PADDING_PX[kind]);
  if (!Number.isFinite(padding) || padding < 0) {
    throw new RangeError("Mask padding must be a non-negative finite number");
  }
  return padding;
}

function expandedBounds(
  element: SlideElement,
  padding: number,
): { x: number; y: number; width: number; height: number } {
  const left = element.bbox.x - padding;
  const top = element.bbox.y - padding;
  const right = element.bbox.x + element.bbox.width + padding;
  const bottom = element.bbox.y + element.bbox.height + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function targetSvg(
  element: SlideElement,
  bounds: ReturnType<typeof expandedBounds>,
  padding: number,
): string {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  if (element.kind === "shape" && element.shape === "roundRect") {
    const radius = Math.max(0, element.cornerRadiusPx + padding);
    return `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" rx="${radius}" fill="white"/>`;
  }
  if (element.kind === "shape" && element.shape === "ellipse") {
    return `<ellipse cx="${bounds.x + bounds.width / 2}" cy="${bounds.y + bounds.height / 2}" rx="${bounds.width / 2}" ry="${bounds.height / 2}" fill="white"/>`;
  }
  return `<polygon points="${bounds.x},${bounds.y} ${right},${bounds.y} ${right},${bottom} ${bounds.x},${bottom}" fill="white"/>`;
}

export async function buildRemovalMask(
  width: number,
  height: number,
  elements: readonly SlideElement[],
  paddingPx?: RemovalMaskPadding,
): Promise<Buffer> {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("Mask dimensions must be positive integers");
  }

  const targets = elements.flatMap((element) => {
    const padding = paddingFor(element.kind, paddingPx);
    const bounds = expandedBounds(element, padding);
    return [targetSvg(element, bounds, padding)];
  });
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="black"/>${targets.join("")}</svg>`,
  );
  return sharp(svg).png().toBuffer();
}
