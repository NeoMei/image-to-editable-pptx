import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp, { type OverlayOptions } from "sharp";

import type { SlideManifestV2 } from "../contracts.js";
import type { BuiltAsset } from "../fidelity/build.js";
import type { SourceCanvas } from "../image/source.js";

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

async function recompositionPreview(
  background: Buffer,
  assets: readonly AnnotatedAsset[],
): Promise<Buffer> {
  return sharp(background)
    .composite(
      assets.map((asset) => ({
        input: asset.image,
        left: Math.floor(asset.bbox.x),
        top: Math.floor(asset.bbox.y),
      })),
    )
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
    recompositionPreview(input.background, assets),
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
