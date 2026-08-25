import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import sharp from "sharp";
import { z } from "zod";

import { loadConfig, type AppConfig } from "./config.js";
import {
  OcrResultSchema,
  SlideManifestSchema,
  VisionResultSchema,
  type OcrResult,
  type SlideManifest,
  type VisionResult,
} from "./contracts.js";
import { exportPptx } from "./export/pptx.js";
import { extractAsset } from "./image/extract.js";
import { buildRemovalMask } from "./image/mask.js";
import { planSlide } from "./planner.js";
import {
  parseQwenOcrResponse,
  recognizeText,
} from "./providers/qwen-ocr.js";
import {
  analyzeElements,
  parseQwenVisionContent,
} from "./providers/qwen-vision.js";
import { inpaintBackground } from "./providers/wanx-edit.js";
import { readRecording, writeRecording } from "./recording.js";

const RawVisionRecordingSchema = z.object({
  choices: z.array(
    z.object({ message: z.object({ content: z.string() }) }),
  ),
});

const DEFAULT_MODELS = {
  ocr: "qwen3.5-ocr",
  vision: "qwen3-vl-plus",
  edit: "wanx2.1-imageedit",
} as const;

export type ReplayInputs = {
  ocrPath: string;
  visionPath: string;
};

export type Inpaint = (
  source: Buffer,
  mask: Buffer,
  config?: AppConfig,
) => Promise<{ image: Buffer; taskId: string }>;

export type PipelineResult = {
  outDir: string;
  manifestPath: string;
  pptxPath: string;
  ledgerPath: string;
};

export type RunPipelineOptions = {
  imagePath: string;
  outDir: string;
  replay?: ReplayInputs;
  record?: boolean;
  config?: AppConfig;
  inpaint?: Inpaint;
};

export type AnalyzeOptions = Pick<
  RunPipelineOptions,
  "imagePath" | "outDir" | "replay" | "record" | "config"
>;

export type BuildOptions = {
  imagePath: string;
  analysisDir: string;
  outDir: string;
  config?: AppConfig;
  inpaint?: Inpaint;
  record?: boolean;
};

type AnalysisResult = {
  ocr: OcrResult;
  vision: VisionResult;
  durationsMs: { ocr: number; vision: number; analyze: number };
  mode: "live" | "replay";
};

type BuildContext = {
  analysis: AnalysisResult;
  startedAt: number;
};

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function readReplayOcr(path: string): Promise<OcrResult> {
  const payload: unknown = JSON.parse(await readFile(path, "utf8"));
  const normalized = OcrResultSchema.safeParse(payload);
  return normalized.success ? normalized.data : parseQwenOcrResponse(payload);
}

async function readReplayVision(path: string): Promise<VisionResult> {
  const payload: unknown = JSON.parse(await readFile(path, "utf8"));
  const normalized = VisionResultSchema.safeParse(payload);
  if (normalized.success) return normalized.data;

  const raw = RawVisionRecordingSchema.parse(payload);
  const content = raw.choices[0]?.message.content;
  if (content === undefined) {
    throw new Error("Vision replay recording has no completion choice");
  }
  return parseQwenVisionContent(content);
}

function configuredModels(config?: AppConfig): {
  ocr: string;
  vision: string;
  edit: string;
} {
  return config === undefined
    ? DEFAULT_MODELS
    : {
        ocr: config.ocrModel,
        vision: config.visionModel,
        edit: config.editModel,
      };
}

async function inspectSourceImage(image: Buffer): Promise<void> {
  const metadata = await sharp(image).metadata();
  if (metadata.width !== 1280 || metadata.height !== 720) {
    throw new Error(
      `Source image must be exactly 1280x720 pixels; received ${metadata.width ?? "unknown"}x${metadata.height ?? "unknown"}`,
    );
  }
}

export async function analyzeSlide(options: AnalyzeOptions): Promise<AnalysisResult> {
  const startedAt = performance.now();
  const outDir = resolve(options.outDir);
  const image = await readFile(options.imagePath);
  await inspectSourceImage(image);
  await mkdir(outDir, { recursive: true });

  let ocr: OcrResult;
  let vision: VisionResult;
  let ocrDuration: number;
  let visionDuration: number;

  if (options.replay !== undefined) {
    const ocrStartedAt = performance.now();
    ocr = await readReplayOcr(options.replay.ocrPath);
    ocrDuration = elapsed(ocrStartedAt);
    const visionStartedAt = performance.now();
    vision = await readReplayVision(options.replay.visionPath);
    visionDuration = elapsed(visionStartedAt);
  } else {
    const config = options.config ?? loadConfig();
    const ocrStartedAt = performance.now();
    const ocrPromise = recognizeText(image, config).then((result) => {
      ocrDuration = elapsed(ocrStartedAt);
      return result;
    });
    const visionStartedAt = performance.now();
    const visionPromise = analyzeElements(image, config).then((result) => {
      visionDuration = elapsed(visionStartedAt);
      return result;
    });
    [ocr, vision] = await Promise.all([ocrPromise, visionPromise]);
    ocrDuration = ocrDuration!;
    visionDuration = visionDuration!;
  }

  await Promise.all([
    writeRecording(join(outDir, "ocr.json"), ocr),
    writeRecording(join(outDir, "vision.json"), vision),
  ]);

  return {
    ocr,
    vision,
    durationsMs: {
      ocr: ocrDuration,
      vision: visionDuration,
      analyze: elapsed(startedAt),
    },
    mode: options.replay === undefined ? "live" : "replay",
  };
}

function outputName(imagePath: string): string {
  const extension = extname(imagePath);
  const stem = basename(imagePath, extension).replace(/^source-/, "");
  return `${stem}-editable.pptx`;
}

function safeAssetOutput(outDir: string, assetPath: string): string {
  if (!/^assets\/[a-zA-Z0-9._-]+\.png$/.test(assetPath)) {
    throw new Error(`Unsafe generated asset path: ${assetPath}`);
  }
  return join(outDir, assetPath);
}

async function buildFromAnalysis(
  options: BuildOptions,
  context: BuildContext,
): Promise<PipelineResult> {
  const outDir = resolve(options.outDir);
  const imagePath = resolve(options.imagePath);
  const image = await readFile(imagePath);
  await inspectSourceImage(image);
  const assetsDir = join(outDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await Promise.all([
    writeRecording(join(outDir, "ocr.json"), context.analysis.ocr),
    writeRecording(join(outDir, "vision.json"), context.analysis.vision),
  ]);

  const planStartedAt = performance.now();
  const planned = planSlide(context.analysis.ocr, context.analysis.vision);
  const planDuration = elapsed(planStartedAt);

  const extractStartedAt = performance.now();
  const finalizedElements = await Promise.all(
    planned.elements.map(async (element) => {
      if (element.kind !== "asset") return element;
      const extracted = await extractAsset(image, element.bbox, {
        extraction: element.extraction,
      });
      await sharp(extracted.image).toFile(safeAssetOutput(outDir, element.assetPath));
      return {
        ...element,
        extraction: extracted.extraction,
        ...(extracted.fallbackReason === undefined
          ? {}
          : { fallbackReason: extracted.fallbackReason }),
      };
    }),
  );
  const extractDuration = elapsed(extractStartedAt);
  const manifest = SlideManifestSchema.parse({
    ...planned,
    elements: finalizedElements,
  });
  const manifestPath = join(outDir, "manifest.json");
  await writeRecording(manifestPath, manifest);

  const maskStartedAt = performance.now();
  const mask = await buildRemovalMask(
    manifest.canvas.width,
    manifest.canvas.height,
    manifest.elements,
  );
  const maskPath = join(outDir, "removal-mask.png");
  await sharp(mask).toFile(maskPath);
  const maskDuration = elapsed(maskStartedAt);

  const config = options.config;
  const inpaint =
    options.inpaint ??
    ((source: Buffer, removalMask: Buffer, suppliedConfig?: AppConfig) =>
      inpaintBackground(source, removalMask, suppliedConfig ?? loadConfig()));
  const inpaintStartedAt = performance.now();
  const clean = await inpaint(image, mask, config);
  const inpaintDuration = elapsed(inpaintStartedAt);
  const cleanBackgroundPath = join(outDir, "clean-background.png");
  await sharp(clean.image).png().toFile(cleanBackgroundPath);

  const pptxPath = join(outDir, outputName(imagePath));
  const exportManifest: SlideManifest = {
    ...manifest,
    elements: manifest.elements.map((element) =>
      element.kind === "asset"
        ? { ...element, assetPath: safeAssetOutput(outDir, element.assetPath) }
        : element,
    ),
  };
  const exportStartedAt = performance.now();
  await exportPptx(exportManifest, cleanBackgroundPath, pptxPath);
  const exportDuration = elapsed(exportStartedAt);

  const assetHashes = Object.fromEntries(
    await Promise.all(
      manifest.elements.flatMap((element) =>
        element.kind === "asset"
          ? [
              sha256File(safeAssetOutput(outDir, element.assetPath)).then(
                (hash) => [element.assetPath, hash] as const,
              ),
            ]
          : [],
      ),
    ),
  );
  const ledgerPath = join(outDir, "run-ledger.json");
  const warnings = [...manifest.warnings];
  const fallbacks = manifest.elements.flatMap((element) =>
    element.kind === "asset" && element.fallbackReason !== undefined
      ? [{ elementId: element.id, reason: element.fallbackReason }]
      : [],
  );
  await writeRecording(ledgerPath, {
    ledgerVersion: 1,
    mode: context.analysis.mode,
    recorded: options.record === true,
    models: configuredModels(config),
    durationsMs: {
      ...context.analysis.durationsMs,
      plan: planDuration,
      extract: extractDuration,
      mask: maskDuration,
      inpaint: inpaintDuration,
      export: exportDuration,
      total: elapsed(context.startedAt),
    },
    taskIds: { wanx: clean.taskId },
    warnings,
    fallbacks,
    hashes: {
      sourceImage: sha256(image),
      ocr: await sha256File(join(outDir, "ocr.json")),
      vision: await sha256File(join(outDir, "vision.json")),
      manifest: await sha256File(manifestPath),
      removalMask: sha256(mask),
      cleanBackground: await sha256File(cleanBackgroundPath),
      assets: assetHashes,
      pptx: await sha256File(pptxPath),
    },
    outputs: {
      directory: outDir,
      ocr: join(outDir, "ocr.json"),
      vision: join(outDir, "vision.json"),
      manifest: manifestPath,
      removalMask: maskPath,
      cleanBackground: cleanBackgroundPath,
      assets: assetsDir,
      pptx: pptxPath,
    },
  });

  return { outDir, manifestPath, pptxPath, ledgerPath };
}

export async function buildSlide(options: BuildOptions): Promise<PipelineResult> {
  const startedAt = performance.now();
  const analysisDir = resolve(options.analysisDir);
  const analysis: AnalysisResult = {
    ocr: await readRecording(join(analysisDir, "ocr.json"), OcrResultSchema),
    vision: await readRecording(
      join(analysisDir, "vision.json"),
      VisionResultSchema,
    ),
    durationsMs: { ocr: 0, vision: 0, analyze: 0 },
    mode: "replay",
  };
  return buildFromAnalysis(options, { analysis, startedAt });
}

export async function runPipeline(
  options: RunPipelineOptions,
): Promise<PipelineResult> {
  const startedAt = performance.now();
  const config =
    options.config ??
    (options.replay === undefined || options.inpaint === undefined
      ? loadConfig()
      : undefined);
  const analysis = await analyzeSlide({
    imagePath: options.imagePath,
    outDir: options.outDir,
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(options.record === undefined ? {} : { record: options.record }),
    ...(config === undefined ? {} : { config }),
  });
  return buildFromAnalysis(
    {
      imagePath: options.imagePath,
      analysisDir: options.outDir,
      outDir: options.outDir,
      ...(options.record === undefined ? {} : { record: options.record }),
      ...(config === undefined ? {} : { config }),
      ...(options.inpaint === undefined ? {} : { inpaint: options.inpaint }),
    },
    { analysis, startedAt },
  );
}
