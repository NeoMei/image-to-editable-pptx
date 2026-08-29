import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import sharp from "sharp";
import { z } from "zod";

import {
  ANALYSIS_LEDGER_NAME,
  readAnalysisPackage,
  readVerifiedAnalysisArtifact,
  writeAnalysisPackageV2,
  type AnalysisArtifact,
  type AnalysisPackageV2,
  type CompletionArtifact,
} from "./analysis/package.js";
import { loadConfig, type AppConfig } from "./config.js";
import {
  CandidateDecisionSchema,
  OcrResultSchema,
  RunLedgerV2Schema,
  Sha256Schema,
  SlideManifestV1Schema,
  SlideManifestV2Schema,
  VisionResultSchema,
  type CandidateDecision,
  type FidelityPlan,
  type OcrResult,
  type SlideManifest,
  type VersionedSlideManifest,
  type VisionResult,
} from "./contracts.js";
import { exportPptx } from "./export/pptx.js";
import {
  buildFidelityLayers,
  buildSemanticLayers,
  readSemanticAssetPublication,
  type BuiltAsset,
  type FidelityBuildResult,
} from "./fidelity/build.js";
import { planFidelityCandidates } from "./fidelity/candidates.js";
import { decodeSourceImage, type SourceCanvas } from "./image/source.js";
import {
  chooseSemanticMask,
  deriveSemanticMasks,
  type MaskCandidate,
} from "./image/semantic-mask.js";
import {
  completeOccludedCandidate,
  OcclusionCompletionBudget,
} from "./occlusion/complete.js";
import type { CompletedCandidate } from "./occlusion/contracts.js";
import { analyzeScene, refineSceneRegions } from "./providers/qwen-scene.js";
import {
  parseQwenOcrResponse,
  recognizeText,
} from "./providers/qwen-ocr.js";
import {
  parseQwenVisionContent,
} from "./providers/qwen-vision.js";
import { createWanxOcclusionCompletionProvider } from "./providers/wanx-edit.js";
import {
  sanitizeHttpResponseBody,
  type ProviderResponseObserver,
} from "./providers/response-observer.js";
import {
  readRecording,
  sanitizeProviderRecording,
  sanitizeRecordingPayload,
  writeProviderMetadataRecording,
  writeRecording,
} from "./recording.js";
import { SceneGraphSchema, type SceneGraph } from "./scene/contracts.js";
import { planSemanticLayers } from "./scene/plan.js";
import { writeQaPreviews, type QaPreviewRecord } from "./qa/previews.js";

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

export const OUTPUT_OWNERSHIP_MARKER =
  ".image-to-editable-pptx-output.json";

const LEGACY_OUTPUT_OWNERSHIP_MARKER =
  ".image-ppt-layers-output.json";

export const OutputOwnershipMarkerSchema = z
  .object({
    markerVersion: z.literal(1),
    appId: z.literal("image-to-editable-pptx"),
    artifactKind: z.literal("published-output"),
  })
  .strict();

const LegacyOutputOwnershipMarkerSchema = z
  .object({
    markerVersion: z.literal(1),
    appId: z.literal("image-ppt-layers"),
    artifactKind: z.literal("published-output"),
  })
  .strict();

const RecognizedOutputOwnershipMarkerSchema = z.union([
  OutputOwnershipMarkerSchema,
  LegacyOutputOwnershipMarkerSchema,
]);

type OwnedOutputDirectory = {
  path: string;
  marker: z.infer<typeof RecognizedOutputOwnershipMarkerSchema>;
};

export const AnalysisLedgerSchema = z
  .object({
    analysisVersion: z.literal(1),
    mode: z.enum(["live", "replay"]),
    recorded: z.boolean(),
    models: z.object({
      ocr: z.string().min(1),
      vision: z.string().min(1),
      edit: z.string().min(1),
    }),
    durationsMs: z.object({
      ocr: z.number().finite().nonnegative(),
      vision: z.number().finite().nonnegative(),
      analyze: z.number().finite().nonnegative(),
    }),
    warnings: z.array(z.string()),
    hashes: z.object({
      sourceImage: Sha256Schema,
      ocr: Sha256Schema,
      vision: Sha256Schema,
    }),
    outputs: z.object({
      ocr: z.literal("ocr.json"),
      vision: z.literal("vision.json"),
    }),
    recordings: z
      .object({
        ocr: z.literal("recordings/ocr.json"),
        vision: z.literal("recordings/vision.json"),
      })
      .optional(),
  })
  .superRefine((ledger, context) => {
    if (ledger.recorded !== (ledger.recordings !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "recorded must match the presence of recording paths",
        path: ["recordings"],
      });
    }
  });

export type AnalysisLedger = z.infer<typeof AnalysisLedgerSchema>;

export type ReplayInputs = {
  ocrPath: string;
  visionPath: string;
};

export type FidelityBuild = typeof buildFidelityLayers;

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
  fidelityBuild?: FidelityBuild;
  requiredTextCount?: number;
};

export type AnalyzeOptions = Pick<
  RunPipelineOptions,
  "imagePath" | "outDir" | "replay" | "record" | "config"
>;

export type BuildOptions = {
  imagePath?: string;
  analysisDir: string;
  outDir: string;
  fidelityBuild?: FidelityBuild;
  requiredTextCount?: number;
};

type AnalysisResultV1 = {
  analysisVersion: 1;
  ocr: OcrResult;
  vision: VisionResult;
  ledger: AnalysisLedger;
};

type AnalysisResultV2 = {
  analysisVersion: 2;
  source: SourceCanvas;
  ocr: OcrResult;
  scene: SceneGraph;
  ledger: AnalysisPackageV2;
  directory: string;
};

type AnalysisResult = AnalysisResultV1 | AnalysisResultV2;

type BuildContext = {
  analysis: AnalysisResult;
  startedAt: number;
  publishedOutDir?: string;
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

function isSameOrAncestor(candidate: string, child: string): boolean {
  const difference = relative(candidate, child);
  return (
    difference === "" ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const canonicalExistingPath = await realpath(cursor);
      return resolve(canonicalExistingPath, ...missingSegments.reverse());
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function requireOwnedOutputDirectory(
  directory: string,
): Promise<OwnedOutputDirectory> {
  let marker: z.infer<typeof RecognizedOutputOwnershipMarkerSchema>;
  try {
    const currentMarkerPath = join(directory, OUTPUT_OWNERSHIP_MARKER);
    try {
      const markerInfo = await lstat(currentMarkerPath);
      if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) {
        throw new Error("Ownership marker must be a regular file");
      }
      marker = await readRecording(
        currentMarkerPath,
        OutputOwnershipMarkerSchema,
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const legacyMarkerPath = join(
        directory,
        LEGACY_OUTPUT_OWNERSHIP_MARKER,
      );
      const markerInfo = await lstat(legacyMarkerPath);
      if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) {
        throw new Error("Ownership marker must be a regular file");
      }
      marker = await readRecording(
        legacyMarkerPath,
        LegacyOutputOwnershipMarkerSchema,
      );
    }
  } catch (error) {
    throw new Error(
      `Refusing to replace unowned output directory: ${directory}`,
      { cause: error },
    );
  }
  return { path: directory, marker };
}

export async function validatePublicationTarget(options: {
  targetPath: string;
  sourceImagePath?: string;
  protectedPaths?: string[];
}): Promise<{ targetDir: string; owned?: OwnedOutputDirectory }> {
  if (options.targetPath.trim() === "") {
    throw new Error("Unsafe output directory: path must not be empty");
  }

  const absoluteTarget = resolve(options.targetPath);
  let targetExists = true;
  let targetIsSymbolicLink = false;
  let targetIsDirectory = false;
  try {
    const targetInfo = await lstat(absoluteTarget);
    targetIsSymbolicLink = targetInfo.isSymbolicLink();
    targetIsDirectory = targetInfo.isDirectory();
  } catch (error) {
    if (isNotFound(error)) {
      targetExists = false;
    } else {
      throw error;
    }
  }

  const [targetDir, cwd, sourceImage, ...protectedPaths] = await Promise.all([
    canonicalizePotentialPath(absoluteTarget),
    realpath(process.cwd()),
    options.sourceImagePath === undefined
      ? Promise.resolve(undefined)
      : realpath(options.sourceImagePath),
    ...(options.protectedPaths ?? []).map((path) => realpath(path)),
  ]);
  if (
    dirname(targetDir) === targetDir ||
    isSameOrAncestor(targetDir, cwd) ||
    (sourceImage !== undefined && isSameOrAncestor(targetDir, sourceImage)) ||
    protectedPaths.some(
      (path) =>
        isSameOrAncestor(targetDir, path) ||
        isSameOrAncestor(path, targetDir),
    )
  ) {
    throw new Error(`Unsafe output directory: ${targetDir}`);
  }

  if (targetIsSymbolicLink) {
    throw new Error(
      `Unsafe output directory: symbolic-link targets are not allowed: ${absoluteTarget}`,
    );
  }
  if (targetExists && !targetIsDirectory) {
    throw new Error(
      `Refusing to replace unowned output directory: ${absoluteTarget}`,
    );
  }

  try {
    const failedRootInfo = await lstat(`${targetDir}.failed-runs`);
    if (failedRootInfo.isSymbolicLink() || !failedRootInfo.isDirectory()) {
      throw new Error(
        `Unsafe failed-run directory: ${targetDir}.failed-runs`,
      );
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (!targetExists) return { targetDir };
  return {
    targetDir,
    owned: await requireOwnedOutputDirectory(targetDir),
  };
}

async function writeOwnershipMarker(directory: string): Promise<void> {
  await writeRecording(
    join(directory, OUTPUT_OWNERSHIP_MARKER),
    OutputOwnershipMarkerSchema.parse({
      markerVersion: 1,
      appId: "image-to-editable-pptx",
      artifactKind: "published-output",
    }),
  );
}

async function removeOwnedOutputDirectory(
  owned: OwnedOutputDirectory,
): Promise<void> {
  RecognizedOutputOwnershipMarkerSchema.parse(owned.marker);
  await rm(owned.path, { recursive: true, force: true });
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

async function canonicalLocalImage(source: SourceCanvas): Promise<Buffer> {
  return sharp(source.rgba, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function prepareAnalysisDirectory(outDir: string): Promise<void> {
  try {
    const info = await lstat(outDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Analysis output directory must be new or empty");
    }
    if ((await readdir(outDir)).length !== 0) {
      throw new Error("Analysis output directory must be new or empty");
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await mkdir(outDir, { recursive: true });
  }
}

function parseErrorRecord(provider: "ocr" | "vision", error: unknown) {
  return {
    provider,
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function responseObserver(
  outDir: string,
  provider: "ocr" | "vision",
  apiKey: string,
): ProviderResponseObserver {
  return {
    recordRawResponse: (payload) =>
      writeRecording(
        join(outDir, `raw-responses/${provider}.json`),
        sanitizeProviderRecording(payload, apiKey),
      ),
    recordRawHttpResponse: (body) =>
      writeRecording(
        join(outDir, `raw-responses/${provider}.json`),
        sanitizeHttpResponseBody(body, apiKey),
      ),
    recordParseError: (error) =>
      writeRecording(
        join(outDir, `parse-errors/${provider}.json`),
        sanitizeRecordingPayload(parseErrorRecord(provider, error)),
      ),
  };
}

async function writeRefinementArtifacts(
  outDir: string,
  result: Awaited<ReturnType<typeof refineSceneRegions>>,
): Promise<AnalysisArtifact[]> {
  if (result.requests.length === 0) return [];
  const directory = join(outDir, "refinements");
  await mkdir(directory, { recursive: true });
  return Promise.all(
    result.requests.map(async (request, index) => {
      const path = `refinements/refinement-${String(index + 1).padStart(3, "0")}.json`;
      const rejectedWarning =
        `regional_refinement_rejected:${request.reason}:${request.targetNodeIds.join(",")}`;
      await writeProviderMetadataRecording(join(outDir, path), {
        request,
        accepted: !result.warnings.includes(rejectedWarning),
      });
      return {
        path,
        sha256: await sha256File(join(outDir, path)),
        crop: request.crop,
      };
    }),
  );
}

async function blankCanvasMask(source: SourceCanvas): Promise<Buffer> {
  return sharp(Buffer.alloc(source.width * source.height), {
    raw: { width: source.width, height: source.height, channels: 1 },
  })
    .png()
    .toBuffer();
}

async function canonicalCrop(
  source: SourceCanvas,
  bbox: MaskCandidate["bbox"],
): Promise<Buffer> {
  return sharp(source.rgba, {
    raw: { width: source.width, height: source.height, channels: 4 },
  })
    .extract({
      left: Math.round(bbox.x),
      top: Math.round(bbox.y),
      width: Math.round(bbox.width),
      height: Math.round(bbox.height),
    })
    .png()
    .toBuffer();
}

async function projectMask(
  mask: MaskCandidate,
  target: MaskCandidate["bbox"],
): Promise<Buffer> {
  const decoded = await sharp(mask.mask)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Math.round(target.width);
  const height = Math.round(target.height);
  const alpha = Buffer.alloc(width * height);
  const sourceLeft = Math.round(mask.bbox.x);
  const sourceTop = Math.round(mask.bbox.y);
  const targetLeft = Math.round(target.x);
  const targetTop = Math.round(target.y);
  for (let y = 0; y < decoded.info.height; y += 1) {
    const targetY = sourceTop + y - targetTop;
    if (targetY < 0 || targetY >= height) continue;
    for (let x = 0; x < decoded.info.width; x += 1) {
      const targetX = sourceLeft + x - targetLeft;
      if (targetX < 0 || targetX >= width) continue;
      alpha[targetY * width + targetX] =
        decoded.data[(y * decoded.info.width + x) * decoded.info.channels + 3]!;
    }
  }
  return sharp(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

async function writeCompletionBinary(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
  await chmodPrivate(path);
}

async function chmodPrivate(path: string): Promise<void> {
  await chmod(path, 0o600);
}

async function completeEligibleCandidates(input: {
  outDir: string;
  source: SourceCanvas;
  ocr: OcrResult;
  scene: SceneGraph;
  config: AppConfig;
}): Promise<{ artifacts: CompletionArtifact[]; requests: number }> {
  const limit = input.config.maxOcclusionCompletions ?? 4;
  const budget = new OcclusionCompletionBudget(limit);
  if (limit === 0) return { artifacts: [], requests: 0 };

  const plan = planSemanticLayers(input.scene, input.ocr);
  const unrelatedTextMask = await blankCanvasMask(input.source);
  const masks = new Map<string, MaskCandidate>();
  for (const candidate of plan.candidates) {
    const proposals = await deriveSemanticMasks(input.source, candidate);
    const selected = chooseSemanticMask(proposals, unrelatedTextMask);
    if (selected !== undefined) masks.set(candidate.id, selected);
  }
  const candidateIdByNodeId = new Map<string, string>();
  for (const candidate of plan.candidates) {
    for (const nodeId of candidate.nodeIds) {
      candidateIdByNodeId.set(nodeId, candidate.id);
    }
  }

  const provider = createWanxOcclusionCompletionProvider(input.config);
  let requests = 0;
  const countedProvider = {
    async complete(request: Parameters<typeof provider.complete>[0]) {
      requests += 1;
      return provider.complete(request);
    },
  };
  const artifacts: CompletionArtifact[] = [];
  for (const candidate of plan.candidates) {
    if (candidate.occlusion === undefined) continue;
    const visible = masks.get(candidate.id);
    if (visible === undefined) continue;
    const occluderMasks = new Map<string, Buffer>();
    let completeMaskSet = true;
    for (const occluderNodeId of candidate.occlusion.occluderIds) {
      const occluderCandidateId = candidateIdByNodeId.get(occluderNodeId);
      const occluder =
        occluderCandidateId === undefined
          ? undefined
          : masks.get(occluderCandidateId);
      if (occluder === undefined) {
        completeMaskSet = false;
        break;
      }
      occluderMasks.set(
        occluderNodeId,
        await projectMask(occluder, visible.bbox),
      );
    }
    if (!completeMaskSet) continue;

    const sourceCrop = await canonicalCrop(input.source, visible.bbox);
    const completed = await completeOccludedCandidate(
      {
        candidate,
        canvas: input.scene.canvas,
        cropBounds: visible.bbox,
        crop: sourceCrop,
        visibleMask: visible.mask,
        occluderMasks,
        semanticContext: [
          `candidate-kind:${candidate.kind}`,
          `relation-count:${candidate.relations.length}`,
        ],
        budget,
        timeoutMs: input.config.requestTimeoutMs,
      },
      countedProvider,
    );
    if (completed === undefined) continue;
    const sequence = String(artifacts.length + 1).padStart(3, "0");
    const path = `completions/completion-${sequence}.png`;
    const sourceCropPath =
      `completions/completion-${sequence}-source-crop.png`;
    const visibleMaskPath =
      `completions/completion-${sequence}-visible-mask.png`;
    const generatedMaskPath =
      `completions/completion-${sequence}-generated-mask.png`;
    await Promise.all([
      writeCompletionBinary(join(input.outDir, path), completed.image),
      writeCompletionBinary(join(input.outDir, sourceCropPath), sourceCrop),
      writeCompletionBinary(
        join(input.outDir, visibleMaskPath),
        completed.visibleMask,
      ),
      writeCompletionBinary(
        join(input.outDir, generatedMaskPath),
        completed.generatedMask,
      ),
    ]);
    artifacts.push({
      path,
      sha256: sha256(completed.image),
      crop: visible.bbox,
      candidateId: candidate.id,
      sourceCropPath,
      visibleMaskPath,
      generatedMaskPath,
      reviewRequired: true,
      provenance: completed.provenance,
    });
  }
  return { artifacts, requests };
}

async function analyzeIntoDirectory(
  options: AnalyzeOptions,
  decodedSource?: SourceCanvas,
): Promise<AnalysisResult> {
  const startedAt = performance.now();
  const outDir = resolve(options.outDir);
  const source = decodedSource ?? await decodeSourceImage(options.imagePath);
  const image = source.sourceBytes;
  await prepareAnalysisDirectory(outDir);

  if (options.replay !== undefined) {
    const ocrStartedAt = performance.now();
    const ocr = await readReplayOcr(options.replay.ocrPath);
    const ocrDuration = elapsed(ocrStartedAt);
    const visionStartedAt = performance.now();
    const vision = await readReplayVision(options.replay.visionPath);
    const visionDuration = elapsed(visionStartedAt);
    await Promise.all([
      writeRecording(join(outDir, "ocr.json"), ocr),
      writeRecording(join(outDir, "vision.json"), vision),
    ]);
    const recorded = options.record === true;
    if (recorded) {
      await Promise.all([
        writeRecording(join(outDir, "recordings/ocr.json"), ocr),
        writeRecording(join(outDir, "recordings/vision.json"), vision),
      ]);
    }
    const ledger = AnalysisLedgerSchema.parse({
      analysisVersion: 1,
      mode: "replay",
      recorded,
      models: configuredModels(options.config),
      durationsMs: {
        ocr: ocrDuration,
        vision: visionDuration,
        analyze: elapsed(startedAt),
      },
      warnings: [],
      hashes: {
        sourceImage: sha256(image),
        ocr: await sha256File(join(outDir, "ocr.json")),
        vision: await sha256File(join(outDir, "vision.json")),
      },
      outputs: { ocr: "ocr.json", vision: "vision.json" },
      ...(recorded
        ? {
            recordings: {
              ocr: "recordings/ocr.json",
              vision: "recordings/vision.json",
            },
          }
        : {}),
    });
    await writeRecording(join(outDir, ANALYSIS_LEDGER_NAME), ledger);
    return { analysisVersion: 1, ocr, vision, ledger };
  }

  const config = options.config ?? loadConfig();
  const canonicalImage = await canonicalLocalImage(source);
  let ocrDuration = 0;
  let fullVisionDuration = 0;
  const ocrStartedAt = performance.now();
  const ocrPromise = recognizeText(
    image,
    config,
    responseObserver(outDir, "ocr", config.apiKey),
  ).finally(() => {
    ocrDuration = elapsed(ocrStartedAt);
  });
  const fullVisionStartedAt = performance.now();
  const scenePromise = analyzeScene(
    canonicalImage,
    { width: source.width, height: source.height },
    config,
    responseObserver(outDir, "vision", config.apiKey),
  ).finally(() => {
    fullVisionDuration = elapsed(fullVisionStartedAt);
  });
  const [ocrOutcome, sceneOutcome] = await Promise.allSettled([
    ocrPromise,
    scenePromise,
  ]);
  if (ocrOutcome.status === "rejected") throw ocrOutcome.reason;
  if (sceneOutcome.status === "rejected") throw sceneOutcome.reason;
  const ocr = ocrOutcome.value;

  const regionalStartedAt = performance.now();
  const refined = await refineSceneRegions(
    canonicalImage,
    sceneOutcome.value,
    config,
    responseObserver(outDir, "vision", config.apiKey),
  );
  const regionalVisionDuration = elapsed(regionalStartedAt);
  const refinements = await writeRefinementArtifacts(outDir, refined);

  const completionStartedAt = performance.now();
  const completion = await completeEligibleCandidates({
    outDir,
    source,
    ocr,
    scene: refined.graph,
    config,
  });
  const completionDuration = elapsed(completionStartedAt);
  const canonicalScene = SceneGraphSchema.parse(refined.graph) as SceneGraph;
  await Promise.all([
    writeRecording(join(outDir, "ocr.json"), ocr),
    writeRecording(join(outDir, "scene-graph.json"), canonicalScene),
  ]);
  const [ocrHash, sceneHash] = await Promise.all([
    sha256File(join(outDir, "ocr.json")),
    sha256File(join(outDir, "scene-graph.json")),
  ]);
  const ledger: AnalysisPackageV2 = {
    analysisVersion: 2,
    mode: "live",
    recorded: options.record === true,
    canvas: { width: source.width, height: source.height },
    source: {
      path: "source.rgba",
      sha256: sha256(source.rgba),
      originalSha256: sha256(source.sourceBytes),
      format: source.format,
    },
    ocr: {
      path: "ocr.json",
      sha256: ocrHash,
    },
    scene: {
      path: "scene-graph.json",
      sha256: sceneHash,
    },
    refinements,
    completions: completion.artifacts,
    requests: {
      ocr: 1,
      fullVision: 1,
      regionalVision: refined.requests.length,
      completion: completion.requests,
    },
    models: {
      ocr: config.ocrModel,
      fullVision: config.visionModel,
      regionalVision: config.visionModel,
      ...(completion.requests === 0 ? {} : { completion: config.editModel }),
    },
    durationsMs: {
      ocr: ocrDuration,
      fullVision: fullVisionDuration,
      regionalVision: regionalVisionDuration,
      completion: completionDuration,
      analyze: elapsed(startedAt),
    },
    warnings: [...refined.warnings],
  };
  await writeAnalysisPackageV2({
    directory: outDir,
    canvas: source,
    ocr,
    scene: canonicalScene,
    refinements,
    completions: completion.artifacts,
    ledger,
  });
  await Promise.all([
    rm(join(outDir, "raw-responses"), { recursive: true, force: true }),
    rm(join(outDir, "parse-errors"), { recursive: true, force: true }),
  ]);
  return {
    analysisVersion: 2,
    source,
    ocr,
    scene: canonicalScene,
    ledger,
    directory: outDir,
  };
}

async function validateStandaloneAnalysisTarget(
  target: string,
): Promise<{ target: string; existedEmpty: boolean }> {
  const absolute = resolve(target);
  try {
    const info = await lstat(absolute);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (await readdir(absolute)).length !== 0
    ) {
      throw new Error("Analysis output directory must be new or empty");
    }
    return { target: absolute, existedEmpty: true };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return { target: absolute, existedEmpty: false };
  }
}

export async function analyzeSlide(options: AnalyzeOptions): Promise<AnalysisResult> {
  const source = await decodeSourceImage(options.imagePath);
  const publication = await validateStandaloneAnalysisTarget(options.outDir);
  const parent = dirname(publication.target);
  await mkdir(parent, { recursive: true });
  const stagingDir = await mkdtemp(
    join(parent, `.${basename(publication.target)}.analysis-staging-`),
  );
  try {
    const result = await analyzeIntoDirectory(
      { ...options, outDir: stagingDir },
      source,
    );
    if (publication.existedEmpty) await rmdir(publication.target);
    await rename(stagingDir, publication.target);
    return result.analysisVersion === 1
      ? result
      : { ...result, directory: publication.target };
  } catch (error) {
    await retainFailedRun(stagingDir, publication.target);
    throw error;
  }
}

function outputName(imagePath?: string): string {
  if (imagePath === undefined) return "slide-editable.pptx";
  const extension = extname(imagePath);
  const stem = basename(imagePath, extension).replace(/^source-/, "");
  return `${stem}-editable.pptx`;
}

function assertRequiredTextCount(
  stage: "planned" | "accepted",
  actual: number,
  requiredTextCount?: number,
): void {
  if (requiredTextCount === undefined) return;
  if (!Number.isSafeInteger(requiredTextCount) || requiredTextCount <= 0) {
    throw new RangeError("requiredTextCount must be a positive integer");
  }
  if (actual !== requiredTextCount) {
    throw new Error(
      `Required text count mismatch: ${stage} ${actual}, required ${requiredTextCount}`,
    );
  }
}

export type AssetOutputPathSemantics = {
  resolve: (...paths: string[]) => string;
  relative: (from: string, to: string) => string;
  isAbsolute: (path: string) => boolean;
  sep: string;
};

const hostAssetOutputPathSemantics: AssetOutputPathSemantics = {
  resolve,
  relative,
  isAbsolute,
  sep,
};

export function resolveSafeAssetOutputPath(
  outDir: string,
  assetPath: string,
  pathSemantics: AssetOutputPathSemantics = hostAssetOutputPathSemantics,
): string {
  if (!/^assets\/[a-zA-Z0-9._-]+\.png$/.test(assetPath)) {
    throw new Error(`Unsafe generated asset path: ${assetPath}`);
  }
  const stagingRoot = pathSemantics.resolve(outDir);
  const nativeAssetPath = assetPath.split("/").join(pathSemantics.sep);
  const output = pathSemantics.resolve(stagingRoot, nativeAssetPath);
  const stagedRelative = pathSemantics.relative(stagingRoot, output);
  if (
    stagedRelative !== nativeAssetPath ||
    pathSemantics.isAbsolute(stagedRelative) ||
    stagedRelative === ".." ||
    stagedRelative.startsWith(`..${pathSemantics.sep}`)
  ) {
    throw new Error(`Generated asset escapes output staging: ${assetPath}`);
  }
  return output;
}

function safeAssetOutput(outDir: string, assetPath: string): string {
  return resolveSafeAssetOutputPath(outDir, assetPath);
}

async function loadVerifiedCompletions(
  analysis: AnalysisResultV2,
): Promise<Map<string, CompletedCandidate>> {
  const completions = new Map<string, CompletedCandidate>();
  for (const artifact of analysis.ledger.completions) {
    if (completions.has(artifact.candidateId)) {
      throw new Error(
        `Duplicate verified completion candidate: ${artifact.candidateId}`,
      );
    }
    if (artifact.provenance.kind !== "composite") {
      throw new Error("Completion artifacts require composite provenance");
    }
    const [image, visibleMask, generatedMask] = await Promise.all([
      readVerifiedAnalysisArtifact(analysis.directory, artifact),
      readVerifiedAnalysisArtifact(analysis.directory, {
        path: artifact.visibleMaskPath,
        sha256: artifact.provenance.visibleMaskSha256,
      }),
      readVerifiedAnalysisArtifact(analysis.directory, {
        path: artifact.generatedMaskPath,
        sha256: artifact.provenance.generatedMaskSha256,
      }),
    ]);
    completions.set(artifact.candidateId, {
      image,
      visibleMask,
      generatedMask,
      reviewRequired: true,
      provenance: artifact.provenance,
    });
  }
  return completions;
}

function verifySemanticPublication(
  publication: Awaited<ReturnType<typeof readSemanticAssetPublication>>,
  assets: readonly BuiltAsset[],
): void {
  if (publication.inventory.length !== assets.length) {
    throw new Error("Semantic asset publication inventory count mismatch");
  }
  const inventory = new Map(
    publication.inventory.map((entry) => [entry.path, entry.sha256]),
  );
  for (const asset of assets) {
    if (inventory.get(asset.assetPath) !== sha256(asset.image)) {
      throw new Error(
        `Semantic asset publication inventory mismatch: ${asset.assetPath}`,
      );
    }
  }
}

function validateFidelityResult(
  plan: FidelityPlan,
  result: FidelityBuildResult,
  manifest: SlideManifest,
): void {
  const expectedCandidates = new Map<string, "text" | "icon">();
  for (const candidate of [...plan.text, ...plan.icons]) {
    if (expectedCandidates.has(candidate.id)) {
      throw new Error(`Duplicate fidelity candidate ID: ${candidate.id}`);
    }
    expectedCandidates.set(candidate.id, candidate.kind);
  }

  const manifestElements = new Map<string, SlideManifest["elements"][number]>();
  for (const element of manifest.elements) {
    if (manifestElements.has(element.id)) {
      throw new Error(`Duplicate fidelity manifest element ID: ${element.id}`);
    }
    manifestElements.set(element.id, element);
  }

  const decisions = z.array(CandidateDecisionSchema).parse(result.decisions);
  const decisionsByCandidate = new Map(
    decisions.map((decision) => [decision.candidateId, decision] as const),
  );
  if (decisionsByCandidate.size !== decisions.length) {
    throw new Error("Duplicate fidelity decision candidate ID");
  }
  for (const candidateId of expectedCandidates.keys()) {
    if (!decisionsByCandidate.has(candidateId)) {
      throw new Error(`Missing fidelity decision for candidate: ${candidateId}`);
    }
  }

  const coveredManifestElements = new Set<string>();
  for (const decision of decisions) {
    const expectedKind = expectedCandidates.get(decision.candidateId);
    if (expectedKind === undefined) {
      throw new Error(
        `Unexpected fidelity decision candidate: ${decision.candidateId}`,
      );
    }
    if (decision.kind !== expectedKind) {
      throw new Error(
        `Fidelity decision kind mismatch for candidate: ${decision.candidateId}`,
      );
    }
    if (decision.decision === "kept_in_background") {
      if (expectedKind === "text") {
        throw new Error(
          `Required text candidate was kept in background: ${decision.candidateId}`,
        );
      }
      if (decision.output.state !== "kept_in_background") {
        throw new Error(
          `Fidelity decision output mismatch for candidate: ${decision.candidateId}`,
        );
      }
      continue;
    }
    if (decision.output.state !== "editable_layer") {
      throw new Error(
        `Fidelity decision output mismatch for candidate: ${decision.candidateId}`,
      );
    }
    const element = manifestElements.get(decision.output.manifestElementId);
    if (element === undefined) {
      throw new Error(
        `Fidelity decision references missing manifest element: ${decision.output.manifestElementId}`,
      );
    }
    if (
      (expectedKind === "text" && element.kind !== "text") ||
      (expectedKind === "icon" && element.kind !== "asset")
    ) {
      throw new Error(
        `Fidelity manifest kind mismatch for candidate: ${decision.candidateId}`,
      );
    }
    if (coveredManifestElements.has(element.id)) {
      throw new Error(`Fidelity manifest element is covered twice: ${element.id}`);
    }
    coveredManifestElements.add(element.id);

    if (element.kind === "text" && decision.output.assetPath !== undefined) {
      throw new Error(
        `Text fidelity decision must not reference an asset: ${decision.candidateId}`,
      );
    }
    if (element.kind === "asset") {
      if (element.extraction !== "transparent") {
        throw new Error(
          `Fidelity asset must use transparent extraction: ${element.id}`,
        );
      }
      if (decision.output.assetPath !== element.assetPath) {
        throw new Error(
          `Fidelity asset path mismatch for candidate: ${decision.candidateId}`,
        );
      }
    }
  }

  for (const elementId of manifestElements.keys()) {
    if (!coveredManifestElements.has(elementId)) {
      throw new Error(`Untracked fidelity manifest element: ${elementId}`);
    }
  }

  const manifestAssetPaths = new Set(
    manifest.elements.flatMap((element) =>
      element.kind === "asset" ? [element.assetPath] : [],
    ),
  );
  for (const assetPath of result.assets.keys()) {
    if (!manifestAssetPaths.has(assetPath)) {
      throw new Error(`Untracked fidelity asset: ${assetPath}`);
    }
  }
  for (const assetPath of manifestAssetPaths) {
    if (!result.assets.has(assetPath)) {
      throw new Error(`Missing fidelity asset: ${assetPath}`);
    }
  }
}

function referencedV2Artifacts(
  ledger: AnalysisPackageV2,
): Array<{ path: string; sha256: string }> {
  const artifacts: Array<{ path: string; sha256: string }> = [
    ledger.source,
    ledger.ocr,
    ledger.scene,
    ...ledger.refinements,
  ];
  for (const completion of ledger.completions) {
    if (completion.provenance.kind !== "composite") {
      throw new Error("Completion artifacts require composite provenance");
    }
    artifacts.push(
      completion,
      {
        path: completion.sourceCropPath,
        sha256: completion.provenance.sourceCropSha256,
      },
      {
        path: completion.visibleMaskPath,
        sha256: completion.provenance.visibleMaskSha256,
      },
      {
        path: completion.generatedMaskPath,
        sha256: completion.provenance.generatedMaskSha256,
      },
    );
  }
  return artifacts;
}

async function copyVerifiedV2PackageArtifacts(
  sourceDirectory: string,
  targetDirectory: string,
  ledger: AnalysisPackageV2,
): Promise<void> {
  await Promise.all(
    referencedV2Artifacts(ledger).map(async (artifact) => {
      const bytes = await readVerifiedAnalysisArtifact(
        sourceDirectory,
        artifact,
      );
      await writeCompletionBinary(
        join(targetDirectory, artifact.path),
        bytes,
      );
    }),
  );
}

async function buildFromAnalysis(
  options: BuildOptions,
  context: BuildContext,
): Promise<PipelineResult> {
  const outDir = resolve(options.outDir);
  const publishedOutDir = resolve(context.publishedOutDir ?? outDir);
  let source: SourceCanvas;
  let sourceImageHash: string;
  let analysisVisualName: "vision.json" | "scene-graph.json";
  let analysisVisual: VisionResult | SceneGraph;
  let runModels: { ocr: string; vision: string; edit?: string };
  let analysisDurations: { ocr: number; vision: number; analyze: number };
  let imagePath: string | undefined;
  if (context.analysis.analysisVersion === 1) {
    if (options.imagePath === undefined) {
      throw new Error("Analysis v1 build requires the external source image");
    }
    imagePath = resolve(options.imagePath);
  }

  if (context.analysis.analysisVersion === 1) {
    source = await decodeSourceImage(imagePath!);
    if (
      sha256(source.sourceBytes) !==
      context.analysis.ledger.hashes.sourceImage
    ) {
      throw new Error("Analysis provenance hash mismatch: sourceImage");
    }
    sourceImageHash = sha256(source.sourceBytes);
    analysisVisualName = "vision.json";
    analysisVisual = context.analysis.vision;
    runModels = {
      ocr: context.analysis.ledger.models.ocr,
      vision: context.analysis.ledger.models.vision,
    };
    analysisDurations = context.analysis.ledger.durationsMs;
  } else {
    source = context.analysis.source;
    sourceImageHash = context.analysis.ledger.source.originalSha256;
    analysisVisualName = "scene-graph.json";
    analysisVisual = context.analysis.scene;
    runModels = {
      ocr: context.analysis.ledger.models.ocr,
      vision: context.analysis.ledger.models.fullVision,
      ...(context.analysis.ledger.models.completion === undefined
        ? {}
        : { edit: context.analysis.ledger.models.completion }),
    };
    analysisDurations = {
      ocr: context.analysis.ledger.durationsMs.ocr,
      vision:
        context.analysis.ledger.durationsMs.fullVision +
        context.analysis.ledger.durationsMs.regionalVision,
      analyze: context.analysis.ledger.durationsMs.analyze,
    };
  }
  const assetsDir = join(outDir, "assets");
  if (
    context.analysis.analysisVersion === 2 &&
    resolve(context.analysis.directory) !== outDir
  ) {
    await copyVerifiedV2PackageArtifacts(
      context.analysis.directory,
      outDir,
      context.analysis.ledger,
    );
    await writeRecording(
      join(outDir, ANALYSIS_LEDGER_NAME),
      context.analysis.ledger,
    );
  } else {
    await Promise.all([
      writeRecording(join(outDir, "ocr.json"), context.analysis.ocr),
      writeRecording(join(outDir, analysisVisualName), analysisVisual),
      writeRecording(
        join(outDir, ANALYSIS_LEDGER_NAME),
        context.analysis.ledger,
      ),
    ]);
  }
  if (context.analysis.analysisVersion === 2) {
    await readAnalysisPackage(outDir);
  }
  if (
    context.analysis.analysisVersion === 1 &&
    context.analysis.ledger.recorded
  ) {
    await Promise.all([
      writeRecording(
        join(outDir, "recordings/ocr.json"),
        context.analysis.ocr,
      ),
      writeRecording(
        join(outDir, "recordings/vision.json"),
        context.analysis.vision,
      ),
    ]);
  }

  const planStartedAt = performance.now();
  const fidelityPlan =
    context.analysis.analysisVersion === 1
      ? planFidelityCandidates(
          context.analysis.ocr,
          context.analysis.vision,
        )
      : undefined;
  const semanticPlan =
    context.analysis.analysisVersion === 2
      ? planSemanticLayers(
          context.analysis.scene,
          context.analysis.ocr,
        )
      : undefined;
  assertRequiredTextCount(
    "planned",
    (fidelityPlan ?? semanticPlan!).text.length,
    options.requiredTextCount,
  );
  const planDuration = elapsed(planStartedAt);

  const repairStartedAt = performance.now();
  let manifest: VersionedSlideManifest;
  let background: Buffer;
  let combinedMask: Buffer;
  let decisions: CandidateDecision[];
  let acceptedAssets: BuiltAsset[] = [];
  if (context.analysis.analysisVersion === 1) {
    await mkdir(assetsDir, { recursive: true });
    const localImage = await canonicalLocalImage(source);
    const fidelityResult: FidelityBuildResult = await (
      options.fidelityBuild ?? buildFidelityLayers
    )(
      localImage,
      fidelityPlan!,
    );
    const v1Manifest = SlideManifestV1Schema.parse(fidelityResult.manifest);
    if (v1Manifest.elements.some((element) => element.kind === "shape")) {
      throw new Error("Fidelity manifests must not contain structural shapes");
    }
    assertRequiredTextCount(
      "accepted",
      v1Manifest.elements.filter((element) => element.kind === "text").length,
      options.requiredTextCount,
    );
    validateFidelityResult(fidelityPlan!, fidelityResult, v1Manifest);
    await Promise.all(
      [...fidelityResult.assets].map(([assetPath, asset]) =>
        writeFile(safeAssetOutput(outDir, assetPath), asset),
      ),
    );
    manifest = v1Manifest;
    background = fidelityResult.background;
    combinedMask = fidelityResult.combinedMask;
    decisions = fidelityResult.decisions;
  } else {
    const completions = await loadVerifiedCompletions({
      ...context.analysis,
      directory: outDir,
    });
    const candidateIds = new Set(semanticPlan!.candidates.map(({ id }) => id));
    for (const candidateId of completions.keys()) {
      if (!candidateIds.has(candidateId)) {
        throw new Error(
          `Verified completion does not match the canonical semantic plan: ${candidateId}`,
        );
      }
    }
    const semanticResult = await buildSemanticLayers({
      source,
      ocr: context.analysis.ocr,
      graph: context.analysis.scene,
      plan: semanticPlan!,
      completions,
      workDir: outDir,
    });
    manifest = SlideManifestV2Schema.parse(semanticResult.manifest);
    background = semanticResult.background;
    combinedMask = semanticResult.combinedMask;
    decisions = semanticResult.decisions;
    acceptedAssets = semanticResult.acceptedAssets;
    const publication = await readSemanticAssetPublication(assetsDir);
    verifySemanticPublication(publication, acceptedAssets);
  }
  const repairDuration = elapsed(repairStartedAt);
  assertRequiredTextCount(
    "accepted",
    manifest.elements.filter((element) => element.kind === "text").length,
    options.requiredTextCount,
  );
  const manifestPath = join(outDir, "manifest.json");
  await writeRecording(manifestPath, manifest);

  const maskPath = join(outDir, "removal-mask.png");
  await writeFile(maskPath, combinedMask);
  const cleanBackgroundPath = join(outDir, "clean-background.png");
  await writeFile(cleanBackgroundPath, background);

  let qaPreviews: QaPreviewRecord[] = [];
  if (manifest.manifestVersion === 2) {
    qaPreviews = await writeQaPreviews({
      canvas: source,
      background,
      assets: acceptedAssets,
      manifest,
      outDir,
    });
  }

  const pptxPath = join(outDir, outputName(imagePath));
  const exportElements = manifest.elements.map((element) =>
    element.kind === "asset"
      ? { ...element, assetPath: safeAssetOutput(outDir, element.assetPath) }
      : element,
  );
  const exportManifest = manifest.manifestVersion === 1
    ? SlideManifestV1Schema.parse({
        ...manifest,
        elements: exportElements,
      })
    : SlideManifestV2Schema.parse({
        ...manifest,
        elements: exportElements,
      });
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
  const qaByKind = new Map(qaPreviews.map((record) => [record.kind, record]));
  const qaHashes =
    manifest.manifestVersion === 2
      ? {
          recomposition: qaByKind.get("recomposition")!.sha256,
          layerReview: qaByKind.get("layer-review")!.sha256,
          exploded: qaByKind.get("exploded")!.sha256,
        }
      : undefined;
  const qaOutputs =
    manifest.manifestVersion === 2
      ? {
          recomposition: join(publishedOutDir, "recomposition-preview.png"),
          layerReview: join(publishedOutDir, "layer-review.png"),
          exploded: join(publishedOutDir, "exploded-preview.png"),
        }
      : undefined;
  const analysisVisualHash = await sha256File(join(outDir, analysisVisualName));
  const ledger = RunLedgerV2Schema.parse({
    ledgerVersion: 2,
    mode: context.analysis.ledger.mode,
    recorded: context.analysis.ledger.recorded,
    models: runModels,
    durationsMs: {
      ...analysisDurations,
      plan: planDuration,
      repair: repairDuration,
      export: exportDuration,
      total: elapsed(context.startedAt),
    },
    taskIds: {},
    warnings: [...context.analysis.ledger.warnings, ...warnings],
    decisions,
    hashes: {
      sourceImage: sourceImageHash,
      ocr: await sha256File(join(outDir, "ocr.json")),
      vision: analysisVisualHash,
      analysisLedger: await sha256File(
        join(outDir, "analysis-ledger.json"),
      ),
      manifest: await sha256File(manifestPath),
      removalMask: await sha256File(maskPath),
      cleanBackground: await sha256File(cleanBackgroundPath),
      assets: assetHashes,
      pptx: await sha256File(pptxPath),
      ...(qaHashes === undefined ? {} : { qaPreviews: qaHashes }),
      ...(manifest.manifestVersion === 1
        ? {}
        : { sceneGraph: analysisVisualHash }),
    },
    outputs: {
      directory: publishedOutDir,
      ocr: join(publishedOutDir, "ocr.json"),
      vision: join(publishedOutDir, analysisVisualName),
      analysisLedger: join(publishedOutDir, ANALYSIS_LEDGER_NAME),
      manifest: join(publishedOutDir, "manifest.json"),
      removalMask: join(publishedOutDir, "removal-mask.png"),
      cleanBackground: join(publishedOutDir, "clean-background.png"),
      assets: join(publishedOutDir, "assets"),
      pptx: join(publishedOutDir, outputName(imagePath)),
      ...(qaOutputs === undefined ? {} : { qaPreviews: qaOutputs }),
      ...(manifest.manifestVersion === 1
        ? {}
        : { sceneGraph: join(publishedOutDir, "scene-graph.json") }),
    },
  });
  await writeRecording(ledgerPath, ledger);
  await writeOwnershipMarker(outDir);

  return { outDir, manifestPath, pptxPath, ledgerPath };
}

async function loadAnalysisPackageV2(
  analysisDir: string,
  ledger: AnalysisPackageV2,
): Promise<AnalysisResultV2> {
  const [rgba, ocrBytes, sceneBytes] = await Promise.all([
    readVerifiedAnalysisArtifact(analysisDir, ledger.source),
    readVerifiedAnalysisArtifact(analysisDir, ledger.ocr),
    readVerifiedAnalysisArtifact(analysisDir, ledger.scene),
  ]);
  return {
    analysisVersion: 2,
    source: {
      format: ledger.source.format,
      width: ledger.canvas.width,
      height: ledger.canvas.height,
      rgba,
      sourceBytes: Buffer.alloc(0),
    },
    ocr: OcrResultSchema.parse(JSON.parse(ocrBytes.toString("utf8"))),
    scene: SceneGraphSchema.parse(
      JSON.parse(sceneBytes.toString("utf8")),
    ) as SceneGraph,
    ledger,
    directory: analysisDir,
  };
}

export async function buildSlide(options: BuildOptions): Promise<PipelineResult> {
  const startedAt = performance.now();
  const analysisDir = resolve(options.analysisDir);
  const ledger = await readAnalysisPackage(analysisDir);
  let analysis: AnalysisResult;
  if (ledger.analysisVersion === 1) {
    if (options.imagePath === undefined) {
      throw new Error("Analysis v1 build requires the external source image");
    }
    const [ocrBytes, visionBytes] = await Promise.all([
      readVerifiedAnalysisArtifact(analysisDir, {
        path: ledger.outputs.ocr,
        sha256: ledger.hashes.ocr,
      }),
      readVerifiedAnalysisArtifact(analysisDir, {
        path: ledger.outputs.vision,
        sha256: ledger.hashes.vision,
      }),
    ]);
    analysis = {
      analysisVersion: 1,
      ocr: OcrResultSchema.parse(JSON.parse(ocrBytes.toString("utf8"))),
      vision: VisionResultSchema.parse(JSON.parse(visionBytes.toString("utf8"))),
      ledger,
    };
  } else {
    analysis = await loadAnalysisPackageV2(analysisDir, ledger);
  }
  return publishOutputAtomically({
    targetPath: options.outDir,
    ...(ledger.analysisVersion === 1
      ? { sourceImagePath: options.imagePath! }
      : {}),
    protectedPaths: [analysisDir],
    build: async (stagingDir, targetDir) => {
      const built = await buildFromAnalysis(
        { ...options, outDir: stagingDir },
        { analysis, startedAt, publishedOutDir: targetDir },
      );
      return {
        outDir: targetDir,
        manifestPath: join(targetDir, "manifest.json"),
        pptxPath: join(targetDir, basename(built.pptxPath)),
        ledgerPath: join(targetDir, "run-ledger.json"),
      };
    },
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

async function promoteSuccessfulRun(
  stagingDir: string,
  targetDir: string,
  sourceImagePath?: string,
  protectedPaths: string[] = [],
): Promise<void> {
  const backupDir = `${targetDir}.previous-${basename(stagingDir)}`;
  let hadPreviousTarget = false;
  let ownedBackup: OwnedOutputDirectory | undefined;

  const publication = await validatePublicationTarget({
    targetPath: targetDir,
    ...(sourceImagePath === undefined ? {} : { sourceImagePath }),
    ...(protectedPaths.length === 0 ? {} : { protectedPaths }),
  });
  if (publication.owned !== undefined) {
    await rename(targetDir, backupDir);
    hadPreviousTarget = true;
    try {
      ownedBackup = await requireOwnedOutputDirectory(backupDir);
    } catch (error) {
      await rename(backupDir, targetDir);
      throw error;
    }
  }

  try {
    await rename(stagingDir, targetDir);
  } catch (error) {
    if (hadPreviousTarget) {
      await rename(backupDir, targetDir);
    }
    throw error;
  }

  if (ownedBackup !== undefined) {
    await removeOwnedOutputDirectory(ownedBackup);
  }
}

async function retainFailedRun(
  stagingDir: string,
  targetDir: string,
): Promise<void> {
  const failedRoot = `${targetDir}.failed-runs`;
  try {
    await mkdir(failedRoot, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) return;
  }
  let failedRootInfo;
  try {
    failedRootInfo = await lstat(failedRoot);
  } catch {
    return;
  }
  if (failedRootInfo.isSymbolicLink() || !failedRootInfo.isDirectory()) {
    return;
  }
  const failedDir = join(failedRoot, basename(stagingDir));
  try {
    await rename(stagingDir, failedDir);
  } catch (error) {
    if (!isNotFound(error)) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}

export async function publishOutputAtomically<T>(options: {
  targetPath: string;
  sourceImagePath?: string;
  protectedPaths?: string[];
  build: (stagingDirectory: string, targetDirectory: string) => Promise<T>;
}): Promise<T> {
  const publication = await validatePublicationTarget({
    targetPath: options.targetPath,
    ...(options.sourceImagePath === undefined
      ? {}
      : { sourceImagePath: options.sourceImagePath }),
    ...(options.protectedPaths === undefined
      ? {}
      : { protectedPaths: options.protectedPaths }),
  });
  const targetDir = publication.targetDir;
  const targetParent = dirname(targetDir);
  await mkdir(targetParent, { recursive: true });
  const stagingDir = await mkdtemp(
    join(targetParent, `.${basename(targetDir)}.staging-`),
  );

  try {
    const result = await options.build(stagingDir, targetDir);
    await promoteSuccessfulRun(
      stagingDir,
      targetDir,
      options.sourceImagePath,
      options.protectedPaths,
    );
    return result;
  } catch (error) {
    await retainFailedRun(stagingDir, targetDir);
    throw error;
  }
}

export async function runPipeline(
  options: RunPipelineOptions,
): Promise<PipelineResult> {
  const startedAt = performance.now();
  return publishOutputAtomically({
    targetPath: options.outDir,
    sourceImagePath: options.imagePath,
    build: async (stagingDir, targetDir) => {
      const config =
        options.config ??
        (options.replay === undefined ? loadConfig() : undefined);
      const analyzed = await analyzeIntoDirectory({
        imagePath: options.imagePath,
        outDir: stagingDir,
        ...(options.replay === undefined ? {} : { replay: options.replay }),
        ...(options.record === undefined ? {} : { record: options.record }),
        ...(config === undefined ? {} : { config }),
      });
      let analysis: AnalysisResult = analyzed;
      if (analyzed.analysisVersion === 2) {
        const verifiedLedger = await readAnalysisPackage(stagingDir);
        if (verifiedLedger.analysisVersion !== 2) {
          throw new Error("Live analysis did not publish an analysis package v2");
        }
        analysis = await loadAnalysisPackageV2(stagingDir, verifiedLedger);
      }
      const built = await buildFromAnalysis(
        {
          imagePath: options.imagePath,
          analysisDir: stagingDir,
          outDir: stagingDir,
          ...(options.requiredTextCount === undefined
            ? {}
            : { requiredTextCount: options.requiredTextCount }),
          ...(options.fidelityBuild === undefined
            ? {}
            : { fidelityBuild: options.fidelityBuild }),
        },
        { analysis, startedAt, publishedOutDir: targetDir },
      );
      return {
        outDir: targetDir,
        manifestPath: join(targetDir, "manifest.json"),
        pptxPath: join(targetDir, basename(built.pptxPath)),
        ledgerPath: join(targetDir, "run-ledger.json"),
      };
    },
  });
}
