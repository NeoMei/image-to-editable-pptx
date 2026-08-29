import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp, { type OverlayOptions } from "sharp";

import type { SlideManifestV2 } from "../contracts.js";
import type { BuiltAsset } from "../fidelity/build.js";
import type { SourceCanvas } from "../image/source.js";
import { buildTightTextMask } from "../image/text-mask.js";

const CELL_WIDTH = 320;
const CELL_HEIGHT = 220;
const CELL_PADDING = 16;
const LABEL_HEIGHT = 36;
const CHECKER_SIZE = 16;
const MAX_COLUMNS = 3;
const REVIEW_RED = "D63A36";

export type QaPreviewRecord = {
  kind: "recomposition" | "layer-review" | "exploded";
  path: string;
  sha256: string;
};

type AnnotatedAsset = BuiltAsset & {
  role: Extract<SlideManifestV2["elements"][number], { kind: "asset" }>["role"];
  generatedReviewOverlay?: Buffer;
};

type ManifestText = Extract<
  SlideManifestV2["elements"][number],
  { kind: "text" }
>;
type ManifestShape = Extract<
  SlideManifestV2["elements"][number],
  { kind: "shape" }
>;

// Recomposition must be deterministic on hosts that do not have Microsoft
// YaHei. Source-derived glyph masks preserve the original script without a
// font dependency. If a safe source mask cannot be recovered, these
// repository-owned 5x7 glyphs provide a deterministic fallback: Latin letters
// and digits remain readable while unsupported Unicode scalars use the stable
// missing-glyph box. The QA raster verifies content presence, geometry, color,
// rotation, alignment, and z-order, not PowerPoint font-level fidelity.
const QA_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "?": ["01110", "10001", "00001", "00110", "00100", "00000", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

const MISSING_QA_GLYPH = [
  "11111",
  "10001",
  "11011",
  "10101",
  "11011",
  "10001",
  "11111",
] as const;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const difference =
      leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function checkerboard(width: number, height: number): Promise<Buffer> {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const light =
        (Math.floor(x / CHECKER_SIZE) + Math.floor(y / CHECKER_SIZE)) % 2 === 0;
      const channel = light ? 242 : 202;
      const offset = (y * width + x) * 4;
      rgba[offset] = channel;
      rgba[offset + 1] = channel;
      rgba[offset + 2] = channel;
      rgba[offset + 3] = 255;
    }
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function validatedAssets(input: {
  canvas: SourceCanvas;
  background: Buffer;
  assets: BuiltAsset[];
  manifest: SlideManifestV2;
}): Promise<AnnotatedAsset[]> {
  if (
    input.canvas.width !== input.manifest.canvas.width ||
    input.canvas.height !== input.manifest.canvas.height ||
    input.canvas.rgba.length !== input.canvas.width * input.canvas.height * 4
  ) {
    throw new Error("QA canvas and manifest dimensions must match");
  }
  const backgroundMetadata = await sharp(input.background).metadata();
  if (
    backgroundMetadata.width !== input.canvas.width ||
    backgroundMetadata.height !== input.canvas.height
  ) {
    throw new Error("QA background dimensions must match the source canvas");
  }
  const manifestAssets = input.manifest.elements.filter(
    (element): element is Extract<typeof element, { kind: "asset" }> =>
      element.kind === "asset",
  );
  const byId = new Map(manifestAssets.map((element) => [element.id, element]));
  if (byId.size !== manifestAssets.length || input.assets.length !== manifestAssets.length) {
    throw new Error("QA assets must match the manifest asset inventory");
  }
  const annotated = await Promise.all(
    input.assets.map(async (asset): Promise<AnnotatedAsset> => {
      const manifestAsset = byId.get(asset.candidateId);
      if (
        manifestAsset === undefined ||
        manifestAsset.assetPath !== asset.assetPath ||
        manifestAsset.zIndex !== asset.zIndex ||
        manifestAsset.reviewRequired !== asset.reviewRequired ||
        !isDeepStrictEqual(manifestAsset.bbox, asset.bbox) ||
        !isDeepStrictEqual(manifestAsset.provenance, asset.provenance)
      ) {
        throw new Error(`QA asset does not match manifest: ${asset.candidateId}`);
      }
      const metadata = await sharp(asset.image).metadata();
      if (
        metadata.width !== Math.ceil(asset.bbox.width) ||
        metadata.height !== Math.ceil(asset.bbox.height)
      ) {
        throw new Error(`QA asset dimensions do not match bbox: ${asset.candidateId}`);
      }
      const visibleMask = await sharp(asset.removalMask)
        .removeAlpha()
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (
        visibleMask.info.width !== input.canvas.width ||
        visibleMask.info.height !== input.canvas.height
      ) {
        throw new Error(
          `QA removal mask dimensions do not match canvas: ${asset.candidateId}`,
        );
      }
      let generatedReviewOverlay: Buffer | undefined;
      if (asset.reviewRequired) {
        const image = await sharp(asset.image)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const overlay = Buffer.alloc(image.info.width * image.info.height * 4);
        const left = Math.floor(asset.bbox.x);
        const top = Math.floor(asset.bbox.y);
        for (let y = 0; y < image.info.height; y += 1) {
          for (let x = 0; x < image.info.width; x += 1) {
            const localIndex = y * image.info.width + x;
            const canvasIndex = (top + y) * input.canvas.width + left + x;
            const assetAlpha = image.data[localIndex * image.info.channels + 3]!;
            const isVisible =
              visibleMask.data[
                canvasIndex * visibleMask.info.channels
              ]! >= 16;
            if (assetAlpha < 16 || isVisible) continue;
            overlay.set([214, 58, 54, 118], localIndex * 4);
          }
        }
        generatedReviewOverlay = await sharp(overlay, {
          raw: {
            width: image.info.width,
            height: image.info.height,
            channels: 4,
          },
        }).png().toBuffer();
      }
      return {
        ...asset,
        role: manifestAsset.role,
        ...(generatedReviewOverlay === undefined
          ? {}
          : { generatedReviewOverlay }),
      };
    }),
  );
  return annotated.sort(
    (left, right) =>
      left.zIndex - right.zIndex ||
      compareCodePoints(left.candidateId, right.candidateId),
  );
}

function svgColor(value: string): string {
  return `#${escapeXml(value.replace(/^#/, ""))}`;
}

function rgbColor(value: string): readonly [number, number, number] | undefined {
  const normalized = value.replace(/^#/, "");
  if (!/^[a-fA-F0-9]{6}$/.test(normalized)) return undefined;
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function shapeLayerSvg(
  canvas: SlideManifestV2["canvas"],
  element: ManifestShape,
): Buffer {
  const { x, y, width, height } = element.bbox;
  const stroke = element.strokeWidthPx === 0
    ? 'stroke="none"'
    : `stroke="${svgColor(element.strokeColor)}" stroke-width="${element.strokeWidthPx}"`;
  let shape: string;
  switch (element.shape) {
    case "ellipse":
      shape = `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${svgColor(element.fillColor)}" ${stroke}/>`;
      break;
    case "line":
      shape = `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y + height}" ${stroke}/>`;
      break;
    case "roundRect": {
      const radius = Math.min(element.cornerRadiusPx, width / 2, height / 2);
      shape = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${svgColor(element.fillColor)}" ${stroke}/>`;
      break;
    }
    case "rect":
      shape = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${svgColor(element.fillColor)}" ${stroke}/>`;
      break;
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" shape-rendering="geometricPrecision">${shape}</svg>`,
  );
}

function qaGlyph(character: string): readonly string[] {
  return QA_GLYPHS[character.toLocaleUpperCase("en-US")] ?? MISSING_QA_GLYPH;
}

function textLayerSvg(
  canvas: SlideManifestV2["canvas"],
  element: ManifestText,
): Buffer {
  const lines = element.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const cell = element.fontSizePx / 7;
  const glyphWidth = cell * 5;
  const glyphGap = cell + (element.charSpacingPx ?? 0);
  const lineGap = cell * 1.4;
  const blockHeight = lines.length * element.fontSizePx + (lines.length - 1) * lineGap;
  const top = element.bbox.y + (element.bbox.height - blockHeight) / 2;
  const rectangles: string[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const characters = [...line];
    const lineWidth = characters.length === 0
      ? 0
      : characters.length * glyphWidth + (characters.length - 1) * glyphGap;
    const left = element.align === "center"
      ? element.bbox.x + (element.bbox.width - lineWidth) / 2
      : element.align === "right"
        ? element.bbox.x + element.bbox.width - lineWidth
        : element.bbox.x;
    for (const [characterIndex, character] of characters.entries()) {
      const glyphLeft = left + characterIndex * (glyphWidth + glyphGap);
      for (const [rowIndex, row] of qaGlyph(character).entries()) {
        for (const [columnIndex, pixel] of [...row].entries()) {
          if (pixel !== "1") continue;
          const expansion = element.bold === true ? cell * 0.12 : 0;
          rectangles.push(
            `<rect x="${glyphLeft + columnIndex * cell - expansion / 2}" y="${top + lineIndex * (element.fontSizePx + lineGap) + rowIndex * cell - expansion / 2}" width="${cell + expansion}" height="${cell + expansion}"/>`,
          );
        }
      }
    }
  }
  const centerX = element.bbox.x + element.bbox.width / 2;
  const centerY = element.bbox.y + element.bbox.height / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" shape-rendering="crispEdges">
      <defs><clipPath id="text-box"><rect x="${element.bbox.x}" y="${element.bbox.y}" width="${element.bbox.width}" height="${element.bbox.height}"/></clipPath></defs>
      <g transform="rotate(${element.rotation} ${centerX} ${centerY})" clip-path="url(#text-box)" fill="${svgColor(element.color)}">${rectangles.join("")}</g>
    </svg>`,
  );
}

async function sourceTextLayer(
  verifiedSourceImage: Buffer,
  canvas: SourceCanvas,
  element: ManifestText,
): Promise<Buffer | undefined> {
  const color = rgbColor(element.color);
  if (color === undefined) return undefined;
  try {
    const tightMask = await buildTightTextMask(
      verifiedSourceImage,
      element,
      { dilationPx: 0 },
    );
    const decodedMask = await sharp(tightMask.mask)
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decodedMask.info.width !== canvas.width ||
      decodedMask.info.height !== canvas.height
    ) {
      return undefined;
    }
    const rgba = Buffer.alloc(canvas.width * canvas.height * 4);
    for (let index = 0; index < canvas.width * canvas.height; index += 1) {
      const alpha = decodedMask.data[index * decodedMask.info.channels]!;
      if (alpha === 0) continue;
      rgba.set([color[0], color[1], color[2], alpha], index * 4);
    }
    return sharp(rgba, {
      raw: { width: canvas.width, height: canvas.height, channels: 4 },
    }).png().toBuffer();
  } catch {
    // The editable-text builder applies the same conservative mask gate. A
    // deterministic vector fallback is safer than trusting host font lookup.
    return undefined;
  }
}

async function recompositionPreview(
  input: {
    canvas: SourceCanvas;
    background: Buffer;
    manifest: SlideManifestV2;
  },
  assets: readonly AnnotatedAsset[],
): Promise<Buffer> {
  const assetsById = new Map(assets.map((asset) => [asset.candidateId, asset]));
  const elements = input.manifest.elements
    .map((element, index) => ({ element, index }))
    .sort(
      (left, right) =>
        left.element.zIndex - right.element.zIndex || left.index - right.index,
    );
  const verifiedSourceImage = elements.some(({ element }) => element.kind === "text")
    ? await sharp(input.canvas.rgba, {
        raw: {
          width: input.canvas.width,
          height: input.canvas.height,
          channels: 4,
        },
      })
        .png()
        .toBuffer()
    : undefined;
  const layers: OverlayOptions[] = await Promise.all(elements.map(async ({ element }) => {
    switch (element.kind) {
      case "asset": {
        const asset = assetsById.get(element.id);
        if (asset === undefined) {
          throw new Error(`QA asset is missing from recomposition: ${element.id}`);
        }
        return {
          input: asset.image,
          left: Math.floor(element.bbox.x),
          top: Math.floor(element.bbox.y),
        };
      }
      case "shape":
        return { input: shapeLayerSvg(input.manifest.canvas, element), left: 0, top: 0 };
      case "text": {
        const sourceLayer = await sourceTextLayer(
          verifiedSourceImage!,
          input.canvas,
          element,
        );
        return {
          input: sourceLayer ?? textLayerSvg(input.manifest.canvas, element),
          left: 0,
          top: 0,
        };
      }
    }
  }));
  return sharp(input.background)
    .composite(layers)
    .png()
    .toBuffer();
}

function cellAnnotationSvg(input: {
  width: number;
  height: number;
  label: string;
  assetLeft: number;
  assetTop: number;
  assetWidth: number;
  assetHeight: number;
  reviewRequired: boolean;
}): Buffer {
  const review = input.reviewRequired
    ? `<rect x="${input.assetLeft + 1}" y="${input.assetTop + 1}" width="${Math.max(1, input.assetWidth - 2)}" height="${Math.max(1, input.assetHeight - 2)}" fill="none" stroke="#${REVIEW_RED}" stroke-width="4"/>
       <path d="M ${input.assetLeft} ${input.assetTop + input.assetHeight} L ${input.assetLeft + input.assetWidth} ${input.assetTop}" stroke="#${REVIEW_RED}" stroke-width="3" opacity="0.9"/>
       <text x="${input.assetLeft + 6}" y="${input.assetTop + 20}" fill="#${REVIEW_RED}" font-family="Arial, sans-serif" font-size="14" font-weight="700">GENERATED REVIEW</text>`
    : "";
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}">
      <rect x="0.5" y="0.5" width="${input.width - 1}" height="${input.height - 1}" fill="none" stroke="#69737D" stroke-width="1"/>
      ${review}
      <rect x="0" y="${input.height - LABEL_HEIGHT}" width="${input.width}" height="${LABEL_HEIGHT}" fill="#17212B" opacity="0.94"/>
      <text x="12" y="${input.height - 13}" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="17" font-weight="600">${escapeXml(input.label)}</text>
    </svg>`,
  );
}

async function layerReviewPreview(
  assets: readonly AnnotatedAsset[],
): Promise<Buffer> {
  const count = Math.max(1, assets.length);
  const columns = Math.min(MAX_COLUMNS, count);
  const rows = Math.ceil(count / columns);
  const width = columns * CELL_WIDTH;
  const height = rows * CELL_HEIGHT;
  const composites: OverlayOptions[] = [];
  for (const [index, asset] of assets.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellLeft = column * CELL_WIDTH;
    const cellTop = row * CELL_HEIGHT;
    const availableWidth = CELL_WIDTH - CELL_PADDING * 2;
    const availableHeight = CELL_HEIGHT - LABEL_HEIGHT - CELL_PADDING * 2;
    const metadata = await sharp(asset.image).metadata();
    const scale = Math.min(
      availableWidth / metadata.width!,
      availableHeight / metadata.height!,
    );
    const assetWidth = Math.max(1, Math.round(metadata.width! * scale));
    const assetHeight = Math.max(1, Math.round(metadata.height! * scale));
    const assetLeft = Math.round((CELL_WIDTH - assetWidth) / 2);
    const assetTop = CELL_PADDING + Math.round((availableHeight - assetHeight) / 2);
    const resized = await sharp(asset.image)
      .resize(assetWidth, assetHeight, { fit: "fill" })
      .png()
      .toBuffer();
    composites.push({
      input: resized,
      left: cellLeft + assetLeft,
      top: cellTop + assetTop,
    });
    if (asset.generatedReviewOverlay !== undefined) {
      composites.push({
        input: await sharp(asset.generatedReviewOverlay)
          .resize(assetWidth, assetHeight, { fit: "fill" })
          .png()
          .toBuffer(),
        left: cellLeft + assetLeft,
        top: cellTop + assetTop,
      });
    }
    composites.push({
      input: cellAnnotationSvg({
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
        label: `${asset.candidateId} [${asset.role}]`,
        assetLeft,
        assetTop,
        assetWidth,
        assetHeight,
        reviewRequired: asset.reviewRequired,
      }),
      left: cellLeft,
      top: cellTop,
    });
  }
  return sharp(await checkerboard(width, height))
    .composite(composites)
    .png()
    .toBuffer();
}

function explodedAnnotationSvg(input: {
  width: number;
  height: number;
  entries: Array<{
    asset: AnnotatedAsset;
    left: number;
    top: number;
    width: number;
    height: number;
  }>;
}): Buffer {
  const fontSize = Math.max(8, Math.min(18, Math.floor(Math.min(input.width, input.height) / 20)));
  const annotations = input.entries.map(({ asset, left, top, width, height }) => {
    const originalX = asset.bbox.x + asset.bbox.width / 2;
    const originalY = asset.bbox.y + asset.bbox.height / 2;
    const movedX = left + width / 2;
    const movedY = top + height / 2;
    const color = asset.reviewRequired ? `#${REVIEW_RED}` : "#23A6D5";
    return `<line x1="${originalX}" y1="${originalY}" x2="${movedX}" y2="${movedY}" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3"/>
      <rect x="${left + 0.5}" y="${top + 0.5}" width="${Math.max(1, width - 1)}" height="${Math.max(1, height - 1)}" fill="none" stroke="${color}" stroke-width="${asset.reviewRequired ? 3 : 1.5}"/>
      <text x="${Math.max(1, left)}" y="${Math.max(fontSize, top - 3)}" fill="${color}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700">${escapeXml(`${asset.candidateId} [${asset.role}]`)}</text>
      ${asset.reviewRequired ? `<text x="${Math.max(1, left)}" y="${Math.min(input.height - 2, top + height + fontSize)}" fill="#${REVIEW_RED}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700">GENERATED REVIEW</text>` : ""}`;
  }).join("\n");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}">${annotations}</svg>`,
  );
}

async function explodedPreview(input: {
  canvas: SourceCanvas;
  background: Buffer;
  assets: readonly AnnotatedAsset[];
}): Promise<Buffer> {
  const directions = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const;
  const amplitude = Math.max(8, Math.round(Math.min(input.canvas.width, input.canvas.height) / 8));
  const entries = input.assets.map((asset, index) => {
    const direction = directions[index % directions.length]!;
    const width = Math.ceil(asset.bbox.width);
    const height = Math.ceil(asset.bbox.height);
    const left = Math.max(
      0,
      Math.min(
        input.canvas.width - width,
        Math.floor(asset.bbox.x) + direction[0] * amplitude,
      ),
    );
    const top = Math.max(
      0,
      Math.min(
        input.canvas.height - height,
        Math.floor(asset.bbox.y) + direction[1] * amplitude,
      ),
    );
    return { asset, left, top, width, height };
  });
  const dimmed = await sharp(input.background)
    .modulate({ brightness: 0.58, saturation: 0.7 })
    .png()
    .toBuffer();
  return sharp(dimmed)
    .composite([
      ...entries.map(({ asset, left, top }) => ({
        input: asset.image,
        left,
        top,
      })),
      ...entries.flatMap(({ asset, left, top }) =>
        asset.generatedReviewOverlay === undefined
          ? []
          : [{ input: asset.generatedReviewOverlay, left, top }],
      ),
      {
        input: explodedAnnotationSvg({
          width: input.canvas.width,
          height: input.canvas.height,
          entries,
        }),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

export async function writeQaPreviews(input: {
  canvas: SourceCanvas;
  background: Buffer;
  assets: BuiltAsset[];
  manifest: SlideManifestV2;
  outDir: string;
}): Promise<QaPreviewRecord[]> {
  const assets = await validatedAssets(input);
  await mkdir(input.outDir, { recursive: true });
  const previews = await Promise.all([
    recompositionPreview(input, assets),
    layerReviewPreview(assets),
    explodedPreview({ ...input, assets }),
  ]);
  const definitions = [
    { kind: "recomposition" as const, name: "recomposition-preview.png" },
    { kind: "layer-review" as const, name: "layer-review.png" },
    { kind: "exploded" as const, name: "exploded-preview.png" },
  ];
  const records: QaPreviewRecord[] = [];
  for (const [index, definition] of definitions.entries()) {
    const path = join(input.outDir, definition.name);
    const bytes = previews[index]!;
    await writeFile(path, bytes, { mode: 0o600 });
    records.push({ kind: definition.kind, path, sha256: sha256(bytes) });
  }
  return records;
}
