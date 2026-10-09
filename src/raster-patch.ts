import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import JSZip from "jszip";
import sharp from "sharp";
import { z } from "zod";

import { BBoxSchema, type BBox } from "./contracts.js";

const MEDIA_PATH_PATTERN = /^ppt\/media\/(?:[^/]+)$/;
const ColorSchema = z.string().regex(
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i,
  "colors must use #RRGGBB or #RRGGBBAA",
);

const RasterPatchTextSchema = z.object({
  text: z.string().min(1),
  box: BBoxSchema,
  fontSize: z.number().finite().positive().max(512),
  color: ColorSchema,
  background: ColorSchema.optional(),
  fontFamily: z.string().min(1).max(128).optional(),
  fontWeight: z.union([z.literal("400"), z.literal("500"), z.literal("600"), z.literal("700"), z.literal("800")]).optional(),
  align: z.enum(["left", "center", "right"]).default("left"),
  rotation: z.number().finite().min(-360).max(360).default(0),
});

export const RasterPatchSpecSchema = z.object({
  mediaPath: z.string().regex(
    MEDIA_PATH_PATTERN,
    "mediaPath must point to a file under ppt/media/",
  ),
  region: BBoxSchema,
  background: ColorSchema.optional(),
  scale: z.number().int().min(1).max(4).default(3),
  texts: z.array(RasterPatchTextSchema).max(256),
}).strict();

export type RasterPatchSpec = z.input<typeof RasterPatchSpecSchema>;
type ParsedRasterPatchSpec = z.output<typeof RasterPatchSpecSchema>;

export type RasterPatchResult = {
  mediaPath: string;
  sourceBytes: number;
  outputBytes: number;
  changedBytes: number;
  output: Buffer;
};

function parseSpec(value: unknown): ParsedRasterPatchSpec {
  const parsed = RasterPatchSpecSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid raster patch spec: ${parsed.error.message}`);
  }
  return parsed.data;
}

function assertIntegerBox(box: BBox, name: string): void {
  if (
    !Number.isSafeInteger(box.x) ||
    !Number.isSafeInteger(box.y) ||
    !Number.isSafeInteger(box.width) ||
    !Number.isSafeInteger(box.height)
  ) {
    throw new RangeError(`${name} coordinates and dimensions must be safe integers`);
  }
}

function assertContained(inner: BBox, outer: BBox, name: string): void {
  if (
    inner.x < 0 ||
    inner.y < 0 ||
    inner.x + inner.width > outer.width ||
    inner.y + inner.height > outer.height
  ) {
    throw new RangeError(`${name} must be contained within the source image`);
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fontFamilyValue(value: string | undefined): string {
  if (value === undefined) return "Arial, sans-serif";
  return `'${escapeXml(value.replaceAll("'", ""))}'`;
}

function svgText(
  text: ParsedRasterPatchSpec["texts"][number],
  scale: number,
): string {
  const box = text.box;
  const x = box.x * scale;
  const y = box.y * scale;
  const width = box.width * scale;
  const height = box.height * scale;
  const fontSize = text.fontSize * scale;
  const lineHeight = fontSize * 1.2;
  const lines = text.text.split(/\r?\n/);
  const textAnchor = text.align === "center"
    ? "middle"
    : text.align === "right"
      ? "end"
      : "start";
  const textX = text.align === "center"
    ? x + width / 2
    : text.align === "right"
      ? x + width
      : x;
  const firstBaseline = y + (height - lineHeight * lines.length) / 2 + fontSize;
  const transform = text.rotation === 0
    ? ""
    : ` transform="rotate(${text.rotation} ${x + width / 2} ${y + height / 2})"`;
  const background = text.background === undefined
    ? ""
    : `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${text.background}"${transform}/>`;
  const tspans = lines.map((line, index) =>
    `<tspan x="${textX}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
  ).join("");
  return `${background}<text x="${textX}" y="${firstBaseline}" text-anchor="${textAnchor}" fill="${text.color}" font-family="${fontFamilyValue(text.fontFamily)}" font-size="${fontSize}" font-weight="${text.fontWeight ?? "400"}"${transform}>${tspans}</text>`;
}

function createOverlaySvg(
  spec: ParsedRasterPatchSpec,
): Buffer {
  const width = spec.region.width * spec.scale;
  const height = spec.region.height * spec.scale;
  const background = spec.background === undefined
    ? ""
    : `<rect width="${width}" height="${height}" fill="${spec.background}"/>`;
  const texts = spec.texts.map((text) => svgText(text, spec.scale)).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g>${background}${texts}</g></svg>`,
  );
}

function countChangedBytes(source: Buffer, output: Buffer): number {
  const shared = Math.min(source.length, output.length);
  let changed = Math.abs(source.length - output.length);
  for (let index = 0; index < shared; index += 1) {
    if (source[index] !== output[index]) changed += 1;
  }
  return changed;
}

async function renderPatchedImage(
  imageBytes: Buffer,
  spec: ParsedRasterPatchSpec,
): Promise<Buffer> {
  const metadata = await sharp(imageBytes).metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error("Target media image dimensions are unavailable");
  }
  const imageBounds: BBox = {
    x: 0,
    y: 0,
    width: metadata.width,
    height: metadata.height,
  };
  assertIntegerBox(spec.region, "region");
  assertContained(spec.region, imageBounds, "region");
  for (const [index, text] of spec.texts.entries()) {
    assertIntegerBox(text.box, `texts[${index}].box`);
    assertContained(text.box, {
      x: 0,
      y: 0,
      width: spec.region.width,
      height: spec.region.height,
    }, `texts[${index}].box`);
  }

  const overlay = await sharp(createOverlaySvg(spec))
    .resize(spec.region.width, spec.region.height, { fit: "fill" })
    .png()
    .toBuffer();
  const patched = sharp(imageBytes).composite([{
    input: overlay,
    left: spec.region.x,
    top: spec.region.y,
  }]);
  if (metadata.format === "png") return patched.png().toBuffer();
  if (metadata.format === "jpeg") {
    return patched.jpeg({ quality: 100 }).toBuffer();
  }
  throw new Error(`Target media format ${metadata.format ?? "unknown"} is not supported; use PNG or JPEG`);
}

export async function applyRasterPatchPptx(
  source: Buffer,
  rawSpec: unknown,
): Promise<RasterPatchResult> {
  const spec = parseSpec(rawSpec);
  const archive = await JSZip.loadAsync(source, { checkCRC32: true });
  const entry = archive.file(spec.mediaPath);
  if (entry === null) {
    throw new Error(`PPTX media entry does not exist: ${spec.mediaPath}`);
  }
  const originalImage = await entry.async("nodebuffer");
  const patchedImage = await renderPatchedImage(originalImage, spec);
  archive.file(spec.mediaPath, patchedImage);
  const output = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  return {
    mediaPath: spec.mediaPath,
    sourceBytes: source.length,
    outputBytes: output.length,
    changedBytes: countChangedBytes(originalImage, patchedImage),
    output,
  };
}

export async function patchRasterPptxFile(
  inputPath: string,
  patchPath: string,
  outputPath: string,
): Promise<RasterPatchResult> {
  const [source, patchJson] = await Promise.all([
    readFile(inputPath),
    readFile(patchPath, "utf8"),
  ]);
  let rawSpec: unknown;
  try {
    rawSpec = JSON.parse(patchJson);
  } catch (error) {
    throw new Error("Raster patch spec must be valid JSON", { cause: error });
  }
  const result = await applyRasterPatchPptx(source, rawSpec);
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath) || "patched.pptx"}.${process.pid}.tmp`,
  );
  try {
    await writeFile(temporaryPath, result.output, { flag: "wx" });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return result;
}
