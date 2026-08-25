import sharp from "sharp";

import type { TextSlideElement } from "../contracts.js";

export type TextMaskOptions = {
  colorDistance?: number;
  dilationPx?: number;
};

export type TextMaskResult = {
  mask: Buffer;
  maskedPixels: number;
  surfaceRgb: readonly [number, number, number];
  glyphRgb: readonly [number, number, number];
  glyphBounds: { x: number; y: number; width: number; height: number };
  inBoxForegroundCoverage: number;
  estimatedStrokeWidthPx: number;
};

const DEFAULT_COLOR_DISTANCE = 32;
const DEFAULT_DILATION_PX = 1;
const MAX_SURFACE_CHANNEL_MAD = 18;
const MAX_MASKED_BOX_RATIO = 0.85;
const MIN_SURFACE_SAMPLES = 8;
// OCR boxes occasionally stop on the last solid glyph column. Capture only
// contrasting pixels connected to an in-box glyph in this bounded halo;
// dilation adds no more than its requested radius beyond that fringe.
const MAX_OCR_EDGE_FRINGE_PX = 8;
const MAX_CONNECTED_FRINGE_TO_GLYPH_RATIO = 0.25;
const LINE_LIKE_FRINGE_SPAN_RATIO = 0.5;
const MAX_LINE_LIKE_FRINGE_THICKNESS_PX = 2;

type Rgb = readonly [number, number, number];

type Bounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function validatedOption(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle]!;
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + upper) / 2 : upper;
}

function channelMedians(colors: readonly Rgb[]): Rgb {
  return [
    median(colors.map((color) => color[0])),
    median(colors.map((color) => color[1])),
    median(colors.map((color) => color[2])),
  ];
}

function channelMedianAbsoluteDeviations(
  colors: readonly Rgb[],
  channelMedians: Rgb,
): Rgb {
  return [
    median(colors.map((color) => Math.abs(color[0] - channelMedians[0]))),
    median(colors.map((color) => Math.abs(color[1] - channelMedians[1]))),
    median(colors.map((color) => Math.abs(color[2] - channelMedians[2]))),
  ];
}

function clampedBounds(
  element: TextSlideElement,
  width: number,
  height: number,
): Bounds {
  const left = Math.max(0, Math.min(width, Math.floor(element.bbox.x)));
  const top = Math.max(0, Math.min(height, Math.floor(element.bbox.y)));
  const right = Math.max(
    0,
    Math.min(width, Math.ceil(element.bbox.x + element.bbox.width)),
  );
  const bottom = Math.max(
    0,
    Math.min(height, Math.ceil(element.bbox.y + element.bbox.height)),
  );
  if (right <= left || bottom <= top) {
    throw new RangeError(`Text bbox does not intersect the source image for ${element.id}`);
  }
  return { left, top, right, bottom };
}

function expandBounds(
  bounds: Bounds,
  width: number,
  height: number,
  padding: number,
): Bounds {
  return {
    left: Math.max(0, bounds.left - padding),
    top: Math.max(0, bounds.top - padding),
    right: Math.min(width, bounds.right + padding),
    bottom: Math.min(height, bounds.bottom + padding),
  };
}

function rgbAt(data: Buffer, width: number, x: number, y: number): Rgb {
  const offset = (y * width + x) * 4;
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!];
}

function localSurfaceRing(
  data: Buffer,
  width: number,
  height: number,
  bounds: Bounds,
): Rgb[] {
  const colors: Rgb[] = [];
  const ringLeft = Math.max(0, bounds.left - 1);
  const ringTop = Math.max(0, bounds.top - 1);
  const ringRight = Math.min(width, bounds.right + 1);
  const ringBottom = Math.min(height, bounds.bottom + 1);

  for (let y = ringTop; y < ringBottom; y += 1) {
    for (let x = ringLeft; x < ringRight; x += 1) {
      const insideBox =
        x >= bounds.left &&
        x < bounds.right &&
        y >= bounds.top &&
        y < bounds.bottom;
      if (!insideBox) colors.push(rgbAt(data, width, x, y));
    }
  }
  return colors;
}

function maxChannelDistance(left: Rgb, right: Rgb): number {
  return Math.max(
    Math.abs(left[0] - right[0]),
    Math.abs(left[1] - right[1]),
    Math.abs(left[2] - right[2]),
  );
}

function dilate(
  foreground: Uint8Array,
  width: number,
  height: number,
  radius: number,
  bounds: Bounds,
): Uint8Array {
  if (radius === 0) return foreground;
  const result = new Uint8Array(foreground.length);
  for (let index = 0; index < foreground.length; index += 1) {
    if (foreground[index] === 0) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -radius; dy <= radius; dy += 1) {
      const targetY = y + dy;
      if (targetY < bounds.top || targetY >= bounds.bottom || targetY >= height) {
        continue;
      }
      for (let dx = -radius; dx <= radius; dx += 1) {
        const targetX = x + dx;
        if (targetX < bounds.left || targetX >= bounds.right || targetX >= width) {
          continue;
        }
        result[targetY * width + targetX] = 255;
      }
    }
  }
  return result;
}

function countMaskedPixelsInBounds(
  mask: Uint8Array,
  width: number,
  bounds: Bounds,
): number {
  let count = 0;
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      if (mask[y * width + x] !== 0) count += 1;
    }
  }
  return count;
}

function countMaskedPixels(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) {
    if (value !== 0) count += 1;
  }
  return count;
}

function connectedContrastingForeground(
  candidates: Uint8Array,
  width: number,
  bounds: Bounds,
  foregroundBounds: Bounds,
): Uint8Array {
  const connected = new Uint8Array(candidates.length);
  const queue: number[] = [];
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const index = y * width + x;
      if (candidates[index] === 0) continue;
      connected[index] = 255;
      queue.push(index);
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]!;
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nextX = x + dx;
        const nextY = y + dy;
        if (
          nextX < foregroundBounds.left ||
          nextX >= foregroundBounds.right ||
          nextY < foregroundBounds.top ||
          nextY >= foregroundBounds.bottom
        ) {
          continue;
        }
        const nextIndex = nextY * width + nextX;
        if (candidates[nextIndex] === 0 || connected[nextIndex] !== 0) continue;
        connected[nextIndex] = 255;
        queue.push(nextIndex);
      }
    }
  }
  return connected;
}

function foregroundGeometry(
  foreground: Uint8Array,
  width: number,
  bounds: Bounds,
): {
  glyphBounds: { x: number; y: number; width: number; height: number };
  estimatedStrokeWidthPx: number;
} {
  let left = bounds.right;
  let top = bounds.bottom;
  let right = bounds.left - 1;
  let bottom = bounds.top - 1;
  const localRuns: number[] = [];
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      if (foreground[y * width + x] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      let horizontalRun = 1;
      for (let next = x - 1; next >= bounds.left && foreground[y * width + next] !== 0; next -= 1) horizontalRun += 1;
      for (let next = x + 1; next < bounds.right && foreground[y * width + next] !== 0; next += 1) horizontalRun += 1;
      let verticalRun = 1;
      for (let next = y - 1; next >= bounds.top && foreground[next * width + x] !== 0; next -= 1) verticalRun += 1;
      for (let next = y + 1; next < bounds.bottom && foreground[next * width + x] !== 0; next += 1) verticalRun += 1;
      localRuns.push(Math.min(horizontalRun, verticalRun));
    }
  }
  if (right < left || bottom < top || localRuns.length === 0) {
    throw new Error("Text mask foreground geometry is empty");
  }
  return {
    glyphBounds: {
      x: left,
      y: top,
      width: right - left + 1,
      height: bottom - top + 1,
    },
    estimatedStrokeWidthPx: median(localRuns),
  };
}

function outsideFringeComponents(
  foreground: Uint8Array,
  width: number,
  bounds: Bounds,
  foregroundBounds: Bounds,
): Array<{ pixels: number; width: number; height: number }> {
  const visited = new Uint8Array(foreground.length);
  const components: Array<{ pixels: number; width: number; height: number }> = [];
  const outside = (x: number, y: number) =>
    x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom;
  for (let y = foregroundBounds.top; y < foregroundBounds.bottom; y += 1) {
    for (let x = foregroundBounds.left; x < foregroundBounds.right; x += 1) {
      const start = y * width + x;
      if (!outside(x, y) || foreground[start] === 0 || visited[start] !== 0) continue;
      let left = x;
      let right = x;
      let top = y;
      let bottom = y;
      let pixels = 0;
      const queue = [start];
      visited[start] = 1;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor]!;
        const currentX = index % width;
        const currentY = Math.floor(index / width);
        pixels += 1;
        left = Math.min(left, currentX);
        right = Math.max(right, currentX);
        top = Math.min(top, currentY);
        bottom = Math.max(bottom, currentY);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nextX = currentX + dx;
            const nextY = currentY + dy;
            if (
              nextX < foregroundBounds.left ||
              nextX >= foregroundBounds.right ||
              nextY < foregroundBounds.top ||
              nextY >= foregroundBounds.bottom ||
              !outside(nextX, nextY)
            ) continue;
            const nextIndex = nextY * width + nextX;
            if (foreground[nextIndex] === 0 || visited[nextIndex] !== 0) continue;
            visited[nextIndex] = 1;
            queue.push(nextIndex);
          }
        }
      }
      components.push({
        pixels,
        width: right - left + 1,
        height: bottom - top + 1,
      });
    }
  }
  return components;
}

function validateFringeSafety(
  foreground: Uint8Array,
  width: number,
  bounds: Bounds,
  foregroundBounds: Bounds,
  inBoxForegroundPixels: number,
  elementId: string,
): void {
  const components = outsideFringeComponents(
    foreground,
    width,
    bounds,
    foregroundBounds,
  );
  const boxWidth = bounds.right - bounds.left;
  const boxHeight = bounds.bottom - bounds.top;
  if (
    components.some(
      (component) =>
        (component.height <= MAX_LINE_LIKE_FRINGE_THICKNESS_PX &&
          component.width / boxWidth >= LINE_LIKE_FRINGE_SPAN_RATIO) ||
        (component.width <= MAX_LINE_LIKE_FRINGE_THICKNESS_PX &&
          component.height / boxHeight >= LINE_LIKE_FRINGE_SPAN_RATIO),
    )
  ) {
    throw new Error(
      `Text mask fringe would capture line-like structure for ${elementId}`,
    );
  }
  const outsidePixels = components.reduce(
    (total, component) => total + component.pixels,
    0,
  );
  if (outsidePixels / inBoxForegroundPixels > MAX_CONNECTED_FRINGE_TO_GLYPH_RATIO) {
    throw new Error(
      `Text mask fringe would remove too much outside the OCR box for ${elementId}`,
    );
  }
}

export async function buildTightTextMask(
  source: Buffer,
  element: TextSlideElement,
  options: TextMaskOptions = {},
): Promise<TextMaskResult> {
  const colorDistance = validatedOption(
    "colorDistance",
    options.colorDistance ?? DEFAULT_COLOR_DISTANCE,
  );
  const requestedDilationPx = validatedOption(
    "dilationPx",
    options.dilationPx ?? DEFAULT_DILATION_PX,
  );
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bounds = clampedBounds(element, info.width, info.height);
  const foregroundBounds = expandBounds(
    bounds,
    info.width,
    info.height,
    Math.min(
      MAX_OCR_EDGE_FRINGE_PX,
      Math.max(2, Math.round(element.bbox.height / 6)),
    ),
  );
  const surfaceSamples = localSurfaceRing(
    data,
    info.width,
    info.height,
    bounds,
  );
  if (surfaceSamples.length < MIN_SURFACE_SAMPLES) {
    throw new Error("Text mask surface is not locally consistent");
  }
  const surfaceRgb = channelMedians(surfaceSamples);
  const surfaceMad = channelMedianAbsoluteDeviations(surfaceSamples, surfaceRgb);
  if (surfaceMad.some((deviation) => deviation > MAX_SURFACE_CHANNEL_MAD)) {
    throw new Error("Text mask surface is not locally consistent");
  }

  const candidates = new Uint8Array(info.width * info.height);
  let foregroundPixels = 0;
  for (let y = foregroundBounds.top; y < foregroundBounds.bottom; y += 1) {
    for (let x = foregroundBounds.left; x < foregroundBounds.right; x += 1) {
      const color = rgbAt(data, info.width, x, y);
      if (maxChannelDistance(color, surfaceRgb) < colorDistance) {
        continue;
      }
      candidates[y * info.width + x] = 255;
      if (x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom) {
        foregroundPixels += 1;
      }
    }
  }
  if (foregroundPixels === 0) {
    throw new Error(`Text mask did not find contrasting glyph pixels for ${element.id}`);
  }
  const boxPixels = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
  if (foregroundPixels === boxPixels) {
    throw new Error(`Text mask would remove the full OCR box for ${element.id}`);
  }
  const foreground = connectedContrastingForeground(
    candidates,
    info.width,
    bounds,
    foregroundBounds,
  );
  validateFringeSafety(
    foreground,
    info.width,
    bounds,
    foregroundBounds,
    foregroundPixels,
    element.id,
  );
  const geometry = foregroundGeometry(candidates, info.width, bounds);
  const glyphColors: Rgb[] = [];
  for (let y = foregroundBounds.top; y < foregroundBounds.bottom; y += 1) {
    for (let x = foregroundBounds.left; x < foregroundBounds.right; x += 1) {
      if (foreground[y * info.width + x] !== 0) {
        glyphColors.push(rgbAt(data, info.width, x, y));
      }
    }
  }
  const glyphRgb = channelMedians(glyphColors);

  const effectiveDilationPx = Math.min(
    requestedDilationPx,
    Math.max(0, Math.floor(element.bbox.height / 4)),
  );
  const maskData = dilate(
    foreground,
    info.width,
    info.height,
    Math.floor(effectiveDilationPx),
    foregroundBounds,
  );
  for (let y = foregroundBounds.top; y < foregroundBounds.bottom; y += 1) {
    for (let x = foregroundBounds.left; x < foregroundBounds.right; x += 1) {
      const outsideBox =
        x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom;
      if (outsideBox && foreground[y * info.width + x] !== 0) {
        maskData[y * info.width + x] = 255;
      }
    }
  }
  const maskedBoxPixels = countMaskedPixelsInBounds(maskData, info.width, bounds);
  if (maskedBoxPixels / boxPixels >= MAX_MASKED_BOX_RATIO) {
    throw new Error(`Text mask would remove too much of the OCR box for ${element.id}`);
  }
  const maskedPixels = countMaskedPixels(maskData);
  const mask = await sharp(maskData, {
    raw: { width: info.width, height: info.height, channels: 1 },
  })
    .toColourspace("b-w")
    .png()
    .toBuffer();

  return {
    mask,
    maskedPixels,
    surfaceRgb,
    glyphRgb,
    glyphBounds: geometry.glyphBounds,
    inBoxForegroundCoverage: foregroundPixels / boxPixels,
    estimatedStrokeWidthPx: geometry.estimatedStrokeWidthPx,
  };
}
