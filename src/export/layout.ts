import type { BBox } from "../contracts.js";
import type { CanvasSize } from "../scene/contracts.js";

const DEFAULT_LONG_SIDE_INCHES = 13.333;
const MIN_SIDE_INCHES = 1;
const MAX_SIDE_INCHES = 56;

export type SlideLayout = {
  widthInches: number;
  heightInches: number;
};

function assertCanvas(canvas: CanvasSize): void {
  if (
    !Number.isSafeInteger(canvas.width) ||
    canvas.width <= 0 ||
    !Number.isSafeInteger(canvas.height) ||
    canvas.height <= 0
  ) {
    throw new RangeError("Canvas dimensions must be positive safe integers");
  }
}

export function layoutForCanvas(canvas: CanvasSize): SlideLayout {
  assertCanvas(canvas);
  const landscape = canvas.width >= canvas.height;
  const longPixels = Math.max(canvas.width, canvas.height);
  const shortPixels = Math.min(canvas.width, canvas.height);
  const aspectRatio = longPixels / shortPixels;
  const defaultShortSide = DEFAULT_LONG_SIDE_INCHES / aspectRatio;
  const longSide =
    defaultShortSide >= MIN_SIDE_INCHES
      ? DEFAULT_LONG_SIDE_INCHES
      : aspectRatio * MIN_SIDE_INCHES;
  const shortSide =
    defaultShortSide >= MIN_SIDE_INCHES
      ? defaultShortSide
      : MIN_SIDE_INCHES;
  if (
    longSide < MIN_SIDE_INCHES ||
    longSide > MAX_SIDE_INCHES ||
    shortSide < MIN_SIDE_INCHES ||
    shortSide > MAX_SIDE_INCHES
  ) {
    throw new RangeError("Canvas aspect ratio exceeds the 1-56 inch PPT layout limits");
  }
  return landscape
    ? { widthInches: longSide, heightInches: shortSide }
    : { widthInches: shortSide, heightInches: longSide };
}

export function positionForBBox(
  bbox: BBox,
  canvas: CanvasSize,
  layout: SlideLayout,
): { x: number; y: number; w: number; h: number } {
  assertCanvas(canvas);
  return {
    x: (bbox.x * layout.widthInches) / canvas.width,
    y: (bbox.y * layout.heightInches) / canvas.height,
    w: (bbox.width * layout.widthInches) / canvas.width,
    h: (bbox.height * layout.heightInches) / canvas.height,
  };
}

export function pixelsToPoints(
  pixels: number,
  canvas: CanvasSize,
  layout: SlideLayout,
): number {
  assertCanvas(canvas);
  return (pixels * layout.heightInches * 72) / canvas.height;
}

export function pixelsToSlideWidth(
  pixels: number,
  canvas: CanvasSize,
  layout: SlideLayout,
): number {
  assertCanvas(canvas);
  return (pixels * layout.widthInches) / canvas.width;
}
