import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
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
} from "node:path";

import sharp from "sharp";
import { z } from "zod";

import { loadConfig, type AppConfig } from "./config.js";
import {
  CandidateDecisionSchema,
  OcrResultSchema,
  RunLedgerV2Schema,
  Sha256Schema,
  SlideManifestSchema,
  VisionResultSchema,
  type FidelityPlan,
  type OcrResult,
  type SlideManifest,
  type VisionResult,
} from "./contracts.js";
import { exportPptx } from "./export/pptx.js";
import {
  buildFidelityLayers,
  type FidelityBuildResult,
} from "./fidelity/build.js";
import { planFidelityCandidates } from "./fidelity/candidates.js";
import {
  parseQwenOcrResponse,
  recognizeText,
} from "./providers/qwen-ocr.js";
import {
  analyzeElements,
  parseQwenVisionContent,
} from "./providers/qwen-vision.js";
import {
  sanitizeHttpResponseBody,
  type ProviderResponseObserver,
} from "./providers/response-observer.js";
import {
  readRecording,
  sanitizeProviderRecording,
  writeRecording,
} from "./recording.js";

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
  imagePath: string;
  analysisDir: string;
  outDir: string;
  fidelityBuild?: FidelityBuild;
  requiredTextCount?: number;
};

type AnalysisResult = {
  ocr: OcrResult;
  vision: VisionResult;
  ledger: AnalysisLedger;
};

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
  sourceImagePath: string;
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

  const [targetDir, sourceImage, cwd] = await Promise.all([
    canonicalizePotentialPath(absoluteTarget),
    realpath(options.sourceImagePath),
    realpath(process.cwd()),
  ]);
  if (
    dirname(targetDir) === targetDir ||
    isSameOrAncestor(targetDir, cwd) ||
    isSameOrAncestor(targetDir, sourceImage)
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

async function inspectSourceImage(image: Buffer): Promise<void> {
  const metadata = await sharp(image).metadata();
  if (metadata.format !== "png") {
    throw new Error(
      `Source image must be a PNG; received ${metadata.format ?? "unknown"}`,
    );
  }
  if (metadata.width !== 1280 || metadata.height !== 720) {
    throw new Error(
      `Source image must be exactly 1280x720 pixels; received ${metadata.width ?? "unknown"}x${metadata.height ?? "unknown"}`,
    );
  }
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
        parseErrorRecord(provider, error),
      ),
  };
}

export async function analyzeSlide(options: AnalyzeOptions): Promise<AnalysisResult> {
  const startedAt = performance.now();
  const outDir = resolve(options.outDir);
  const image = await readFile(options.imagePath);
  await inspectSourceImage(image);
  await prepareAnalysisDirectory(outDir);

  let ocr: OcrResult;
  let vision: VisionResult;
  let ocrDuration: number;
  let visionDuration: number;
  let activeConfig = options.config;

  if (options.replay !== undefined) {
    const ocrStartedAt = performance.now();
    ocr = await readReplayOcr(options.replay.ocrPath);
    ocrDuration = elapsed(ocrStartedAt);
    const visionStartedAt = performance.now();
    vision = await readReplayVision(options.replay.visionPath);
    visionDuration = elapsed(visionStartedAt);
  } else {
    const config = activeConfig ?? loadConfig();
    activeConfig = config;
    const ocrStartedAt = performance.now();
    const ocrPromise = recognizeText(
      image,
      config,
      responseObserver(outDir, "ocr", config.apiKey),
    ).finally(() => {
      ocrDuration = elapsed(ocrStartedAt);
    });
    const visionStartedAt = performance.now();
    const visionPromise = analyzeElements(
      image,
      config,
      responseObserver(outDir, "vision", config.apiKey),
    ).finally(() => {
      visionDuration = elapsed(visionStartedAt);
    });
    const [ocrOutcome, visionOutcome] = await Promise.allSettled([
      ocrPromise,
      visionPromise,
    ]);
    ocrDuration = ocrDuration!;
    visionDuration = visionDuration!;
    if (ocrOutcome.status === "rejected") throw ocrOutcome.reason;
    if (visionOutcome.status === "rejected") throw visionOutcome.reason;
    ocr = ocrOutcome.value;
    vision = visionOutcome.value;
    await rm(join(outDir, "raw-responses"), { recursive: true, force: true });
  }

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
    mode: options.replay === undefined ? "live" : "replay",
    recorded,
    models: configuredModels(activeConfig),
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
  await writeRecording(join(outDir, "analysis-ledger.json"), ledger);

  return {
    ocr,
    vision,
    ledger,
  };
}

function outputName(imagePath: string): string {
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

function safeAssetOutput(outDir: string, assetPath: string): string {
  if (!/^assets\/[a-zA-Z0-9._-]+\.png$/.test(assetPath)) {
    throw new Error(`Unsafe generated asset path: ${assetPath}`);
  }
  return join(outDir, assetPath);
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

async function buildFromAnalysis(
  options: BuildOptions,
  context: BuildContext,
): Promise<PipelineResult> {
  const outDir = resolve(options.outDir);
  const publishedOutDir = resolve(context.publishedOutDir ?? outDir);
  const imagePath = resolve(options.imagePath);
  const image = await readFile(imagePath);
  await inspectSourceImage(image);
  if (sha256(image) !== context.analysis.ledger.hashes.sourceImage) {
    throw new Error("Analysis provenance hash mismatch: sourceImage");
  }
  const assetsDir = join(outDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  await Promise.all([
    writeRecording(join(outDir, "ocr.json"), context.analysis.ocr),
    writeRecording(join(outDir, "vision.json"), context.analysis.vision),
    writeRecording(
      join(outDir, "analysis-ledger.json"),
      context.analysis.ledger,
    ),
  ]);
  if (context.analysis.ledger.recorded) {
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
  const fidelityPlan = planFidelityCandidates(
    context.analysis.ocr,
    context.analysis.vision,
  );
  assertRequiredTextCount(
    "planned",
    fidelityPlan.text.length,
    options.requiredTextCount,
  );
  const planDuration = elapsed(planStartedAt);

  const repairStartedAt = performance.now();
  const fidelityResult: FidelityBuildResult = await (
    options.fidelityBuild ?? buildFidelityLayers
  )(
    image,
    fidelityPlan,
  );
  const repairDuration = elapsed(repairStartedAt);
  const manifest = SlideManifestSchema.parse(fidelityResult.manifest);
  if (manifest.elements.some((element) => element.kind === "shape")) {
    throw new Error("Fidelity manifests must not contain structural shapes");
  }
  assertRequiredTextCount(
    "accepted",
    manifest.elements.filter((element) => element.kind === "text").length,
    options.requiredTextCount,
  );
  validateFidelityResult(fidelityPlan, fidelityResult, manifest);
  await Promise.all(
    [...fidelityResult.assets].map(([assetPath, asset]) =>
      writeFile(safeAssetOutput(outDir, assetPath), asset),
    ),
  );
  const manifestPath = join(outDir, "manifest.json");
  await writeRecording(manifestPath, manifest);

  const maskPath = join(outDir, "removal-mask.png");
  await writeFile(maskPath, fidelityResult.combinedMask);
  const cleanBackgroundPath = join(outDir, "clean-background.png");
  await writeFile(cleanBackgroundPath, fidelityResult.background);

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
  const ledger = RunLedgerV2Schema.parse({
    ledgerVersion: 2,
    mode: context.analysis.ledger.mode,
    recorded: context.analysis.ledger.recorded,
    models: {
      ocr: context.analysis.ledger.models.ocr,
      vision: context.analysis.ledger.models.vision,
    },
    durationsMs: {
      ...context.analysis.ledger.durationsMs,
      plan: planDuration,
      repair: repairDuration,
      export: exportDuration,
      total: elapsed(context.startedAt),
    },
    taskIds: {},
    warnings: [...context.analysis.ledger.warnings, ...warnings],
    decisions: fidelityResult.decisions,
    hashes: {
      sourceImage: sha256(image),
      ocr: await sha256File(join(outDir, "ocr.json")),
      vision: await sha256File(join(outDir, "vision.json")),
      analysisLedger: await sha256File(
        join(outDir, "analysis-ledger.json"),
      ),
      manifest: await sha256File(manifestPath),
      removalMask: await sha256File(maskPath),
      cleanBackground: await sha256File(cleanBackgroundPath),
      assets: assetHashes,
      pptx: await sha256File(pptxPath),
    },
    outputs: {
      directory: publishedOutDir,
      ocr: join(publishedOutDir, "ocr.json"),
      vision: join(publishedOutDir, "vision.json"),
      analysisLedger: join(publishedOutDir, "analysis-ledger.json"),
      manifest: join(publishedOutDir, "manifest.json"),
      removalMask: join(publishedOutDir, "removal-mask.png"),
      cleanBackground: join(publishedOutDir, "clean-background.png"),
      assets: join(publishedOutDir, "assets"),
      pptx: join(publishedOutDir, outputName(imagePath)),
    },
  });
  await writeRecording(ledgerPath, ledger);
  await writeOwnershipMarker(outDir);

  return { outDir, manifestPath, pptxPath, ledgerPath };
}

export async function buildSlide(options: BuildOptions): Promise<PipelineResult> {
  const startedAt = performance.now();
  const publication = await validatePublicationTarget({
    targetPath: options.outDir,
    sourceImagePath: options.imagePath,
  });
  const analysisDir = resolve(options.analysisDir);
  const image = await readFile(options.imagePath);
  const ledger = await readRecording(
    join(analysisDir, "analysis-ledger.json"),
    AnalysisLedgerSchema,
  );
  const ocrPath = join(analysisDir, ledger.outputs.ocr);
  const visionPath = join(analysisDir, ledger.outputs.vision);
  const analysis: AnalysisResult = {
    ocr: await readRecording(ocrPath, OcrResultSchema),
    vision: await readRecording(visionPath, VisionResultSchema),
    ledger,
  };
  const actualHashes = {
    sourceImage: sha256(image),
    ocr: await sha256File(ocrPath),
    vision: await sha256File(visionPath),
  };
  for (const key of ["sourceImage", "ocr", "vision"] as const) {
    if (actualHashes[key] !== ledger.hashes[key]) {
      throw new Error(`Analysis provenance hash mismatch: ${key}`);
    }
  }
  const targetDir = publication.targetDir;
  const targetParent = dirname(targetDir);
  await mkdir(targetParent, { recursive: true });
  const stagingDir = await mkdtemp(
    join(targetParent, `.${basename(targetDir)}.staging-`),
  );

  try {
    await buildFromAnalysis(
      { ...options, outDir: stagingDir },
      { analysis, startedAt, publishedOutDir: targetDir },
    );
    await promoteSuccessfulRun(stagingDir, targetDir, options.imagePath);
    return {
      outDir: targetDir,
      manifestPath: join(targetDir, "manifest.json"),
      pptxPath: join(targetDir, outputName(options.imagePath)),
      ledgerPath: join(targetDir, "run-ledger.json"),
    };
  } catch (error) {
    await retainFailedRun(stagingDir, targetDir);
    throw error;
  }
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
  sourceImagePath: string,
): Promise<void> {
  const backupDir = `${targetDir}.previous-${basename(stagingDir)}`;
  let hadPreviousTarget = false;
  let ownedBackup: OwnedOutputDirectory | undefined;

  const publication = await validatePublicationTarget({
    targetPath: targetDir,
    sourceImagePath,
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

export async function runPipeline(
  options: RunPipelineOptions,
): Promise<PipelineResult> {
  const startedAt = performance.now();
  const publication = await validatePublicationTarget({
    targetPath: options.outDir,
    sourceImagePath: options.imagePath,
  });
  const config =
    options.config ??
    (options.replay === undefined ? loadConfig() : undefined);
  const targetDir = publication.targetDir;
  const targetParent = dirname(targetDir);
  await mkdir(targetParent, { recursive: true });
  const stagingDir = await mkdtemp(
    join(targetParent, `.${basename(targetDir)}.staging-`),
  );

  try {
    const analysis = await analyzeSlide({
      imagePath: options.imagePath,
      outDir: stagingDir,
      ...(options.replay === undefined ? {} : { replay: options.replay }),
      ...(options.record === undefined ? {} : { record: options.record }),
      ...(config === undefined ? {} : { config }),
    });
    await buildFromAnalysis(
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
    await promoteSuccessfulRun(stagingDir, targetDir, options.imagePath);
    return {
      outDir: targetDir,
      manifestPath: join(targetDir, "manifest.json"),
      pptxPath: join(targetDir, outputName(options.imagePath)),
      ledgerPath: join(targetDir, "run-ledger.json"),
    };
  } catch (error) {
    await retainFailedRun(stagingDir, targetDir);
    throw error;
  }
}
