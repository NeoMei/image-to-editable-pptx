import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";
import sharp from "sharp";

import {
  AssetProvenanceSchema,
  OcrResultSchema,
  Sha256Schema,
  VisionResultSchema,
  type BBox,
  type OcrResult,
} from "../contracts.js";
import type { SourceCanvas } from "../image/source.js";
import {
  sanitizeProviderMetadata,
  sanitizeProviderRecording,
  sanitizeRecordingPayload,
  writeRecording,
} from "../recording.js";
import {
  CanvasSizeSchema,
  SceneGraphSchema,
  type CanvasSize,
  type SceneGraph,
} from "../scene/contracts.js";

export const ANALYSIS_LEDGER_NAME = "analysis-ledger.json";

const SafeRelativePathSchema = z
  .string()
  .min(1)
  .refine(isSafeRelativePath, "Expected a safe relative path");

const PixelBBoxSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

export const AnalysisArtifactSchema = z
  .object({
    path: SafeRelativePathSchema,
    sha256: Sha256Schema,
    crop: PixelBBoxSchema.optional(),
  })
  .strict();

export const CompletionArtifactSchema = AnalysisArtifactSchema.extend({
  crop: PixelBBoxSchema,
  candidateId: z.string().min(1),
  sourceCropPath: SafeRelativePathSchema,
  visibleMaskPath: SafeRelativePathSchema,
  generatedMaskPath: SafeRelativePathSchema,
  reviewRequired: z.literal(true),
  provenance: AssetProvenanceSchema,
})
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.provenance.kind !== "composite") {
      context.addIssue({
        code: "custom",
        message: "Completion artifacts require composite provenance",
        path: ["provenance", "kind"],
      });
    } else if (artifact.provenance.assetSha256 !== artifact.sha256) {
      context.addIssue({
        code: "custom",
        message: "Completion provenance asset hash must match the artifact hash",
        path: ["provenance", "assetSha256"],
      });
    }
  });

const RequestCountsSchema = z
  .object({
    ocr: z.number().int().min(0).max(1),
    fullVision: z.number().int().min(0).max(1),
    regionalVision: z.number().int().min(0).max(8),
    completion: z.number().int().min(0).max(4),
  })
  .strict();

const AnalysisModelsSchema = z
  .object({
    ocr: z.string().min(1),
    fullVision: z.string().min(1),
    regionalVision: z.string().min(1),
    completion: z.string().min(1).optional(),
  })
  .strict();

const AnalysisDurationsSchema = z
  .object({
    ocr: z.number().finite().nonnegative(),
    fullVision: z.number().finite().nonnegative(),
    regionalVision: z.number().finite().nonnegative(),
    completion: z.number().finite().nonnegative(),
    analyze: z.number().finite().nonnegative(),
  })
  .strict();

const RoutingAttemptSchema = z.union([
  z.object({
    candidate: z.enum(["host-openai", "api-openai", "host-gemini", "api-gemini", "api-alibaba"]),
    status: z.literal("success"),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  }).strict(),
  z.object({
    candidate: z.enum(["host-openai", "api-openai", "host-gemini", "api-gemini", "api-alibaba"]),
    status: z.enum(["unavailable", "auth_unavailable", "retryable_exhausted", "policy_refused", "invalid_input", "invalid_output", "local_failure"]),
    disposition: z.enum([
      "unavailable", "auth_unavailable", "retryable_exhausted", "policy_refused",
      "invalid_input", "invalid_output", "local_failure", "missing_candidate",
      "capability_unavailable", "credentials_unavailable", "bridge_timeout",
      "invalid_bridge_response", "bridge_local_failure", "unsafe_requests_directory",
      "invalid_bridge_request", "mismatched_request_id", "invalid_model_identifier",
      "invalid_image_artifact",
    ]),
  }).strict(),
]);

export const AnalysisRoutingReportSchema = z.object({
  version: z.literal(1),
  mode: z.literal("serial-forward-sticky"),
  stopped: z.boolean(),
  transportAttempts: z.array(z.object({
    operation: z.enum(["ocr", "scene", "completion"]),
    candidate: z.enum(["host-openai", "api-openai", "host-gemini", "api-gemini", "api-alibaba"]),
    count: z.number().int().positive(),
  }).strict()),
  operations: z.array(z.object({
    sequence: z.number().int().positive(),
    operation: z.enum(["ocr", "scene", "completion"]),
    outcome: z.enum(["success", "fatal", "exhausted"]),
    selectedCandidate: z.enum(["host-openai", "api-openai", "host-gemini", "api-gemini", "api-alibaba"]).optional(),
    selectedModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).optional(),
    attempts: z.array(RoutingAttemptSchema),
  }).strict()),
}).strict();

export const AnalysisPackageV2Schema = z
  .object({
    analysisVersion: z.literal(2),
    mode: z.enum(["live", "replay"]),
    recorded: z.boolean(),
    canvas: CanvasSizeSchema,
    source: z
      .object({
        path: z.literal("source.rgba"),
        sha256: Sha256Schema,
        originalSha256: Sha256Schema,
        format: z.enum(["png", "jpeg"]),
      })
      .strict(),
    ocr: z
      .object({ path: z.literal("ocr.json"), sha256: Sha256Schema })
      .strict(),
    scene: z
      .object({ path: z.literal("scene-graph.json"), sha256: Sha256Schema })
      .strict(),
    refinements: z.array(AnalysisArtifactSchema),
    completions: z.array(CompletionArtifactSchema),
    requests: RequestCountsSchema,
    models: AnalysisModelsSchema,
    durationsMs: AnalysisDurationsSchema,
    warnings: z.array(z.string()),
    routing: AnalysisRoutingReportSchema.optional(),
  })
  .strict()
  .superRefine((ledger, context) => {
    const paths = new Set<string>([
      ledger.source.path,
      ledger.ocr.path,
      ledger.scene.path,
    ]);
    const notePath = (path: string, issuePath: PropertyKey[]): void => {
      if (paths.has(path)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate analysis artifact path: ${path}`,
          path: issuePath,
        });
      }
      paths.add(path);
    };
    for (const [index, artifact] of ledger.refinements.entries()) {
      notePath(artifact.path, ["refinements", index, "path"]);
      if (artifact.crop !== undefined) {
        validateCrop(artifact.crop, ledger.canvas, context, [
          "refinements",
          index,
          "crop",
        ]);
      }
    }
    for (const [index, artifact] of ledger.completions.entries()) {
      notePath(artifact.path, ["completions", index, "path"]);
      notePath(artifact.sourceCropPath, [
        "completions",
        index,
        "sourceCropPath",
      ]);
      notePath(artifact.visibleMaskPath, [
        "completions",
        index,
        "visibleMaskPath",
      ]);
      notePath(artifact.generatedMaskPath, [
        "completions",
        index,
        "generatedMaskPath",
      ]);
      validateCrop(artifact.crop, ledger.canvas, context, [
        "completions",
        index,
        "crop",
      ]);
    }
    if (ledger.refinements.length > ledger.requests.regionalVision) {
      context.addIssue({
        code: "custom",
        message: "Refinement artifacts cannot exceed regional Vision requests",
        path: ["refinements"],
      });
    }
    if (ledger.completions.length > ledger.requests.completion) {
      context.addIssue({
        code: "custom",
        message: "Completion artifacts cannot exceed completion requests",
        path: ["completions"],
      });
    }
  });

const AnalysisPackageV1Schema = z
  .object({
    analysisVersion: z.literal(1),
    mode: z.enum(["live", "replay"]),
    recorded: z.boolean(),
    models: z
      .object({
        ocr: z.string().min(1),
        vision: z.string().min(1),
        edit: z.string().min(1),
      }),
    durationsMs: z
      .object({
        ocr: z.number().finite().nonnegative(),
        vision: z.number().finite().nonnegative(),
        analyze: z.number().finite().nonnegative(),
      }),
    warnings: z.array(z.string()),
    hashes: z
      .object({
        sourceImage: Sha256Schema,
        ocr: Sha256Schema,
        vision: Sha256Schema,
      }),
    outputs: z
      .object({
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

export type AnalysisArtifact = z.infer<typeof AnalysisArtifactSchema>;
export type CompletionArtifact = z.infer<typeof CompletionArtifactSchema>;
export type AnalysisPackageV2 = z.infer<typeof AnalysisPackageV2Schema>;
export type AnalysisPackageV1 = z.infer<typeof AnalysisPackageV1Schema>;

function validateCrop(
  crop: BBox,
  canvas: CanvasSize,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (
    crop.x + crop.width > canvas.width ||
    crop.y + crop.height > canvas.height
  ) {
    context.addIssue({
      code: "custom",
      message: "Artifact crop must stay inside the analysis canvas",
      path,
    });
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSafeRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  const parts = path.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== "..",
  );
}

async function requireRootDirectory(directory: string): Promise<string> {
  const absolute = resolve(directory);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Analysis package directory must be a regular directory: ${absolute}`);
  }
  return realpath(absolute);
}

async function readRegularArtifact(
  directory: string,
  artifactPath: string,
): Promise<Buffer> {
  if (!isSafeRelativePath(artifactPath)) {
    throw new Error(`Analysis artifact path escape; expected a safe relative path: ${artifactPath}`);
  }
  const root = await requireRootDirectory(directory);
  const absolute = resolve(root, artifactPath);
  const difference = relative(root, absolute);
  if (
    difference === "" ||
    difference.startsWith("..") ||
    isAbsolute(difference)
  ) {
    throw new Error(`Analysis artifact path escape: ${artifactPath}`);
  }

  let cursor = root;
  const segments = artifactPath.split("/");
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new Error(`Missing analysis artifact: ${artifactPath}`, {
          cause: error,
        });
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Analysis artifact must not use a symbolic link: ${artifactPath}`);
    }
    const final = index === segments.length - 1;
    if ((final && !info.isFile()) || (!final && !info.isDirectory())) {
      throw new Error(`Analysis artifact must be a regular file: ${artifactPath}`);
    }
  }
  return readFile(absolute);
}

export async function readVerifiedAnalysisArtifact(
  directory: string,
  artifact: { path: string; sha256: string },
): Promise<Buffer> {
  const bytes = await readRegularArtifact(directory, artifact.path);
  if (sha256(bytes) !== artifact.sha256) {
    throw new Error(`Analysis artifact hash mismatch: ${artifact.path}`);
  }
  return bytes;
}

async function writePrivateArtifact(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

function comparable(value: unknown): string {
  return JSON.stringify(sanitizeRecordingPayload(value));
}

function assertNoEmbeddedImagePayloads(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (/data:image\//i.test(current)) {
        throw new Error("Analysis metadata must not contain base64 image payloads");
      }
      if (
        current.length >= 2_048 &&
        /^(?:[a-z0-9+/]{4})+(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(
          current,
        )
      ) {
        throw new Error("Analysis metadata must not contain opaque base64 payloads");
      }
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (typeof current === "object" && current !== null) {
      pending.push(...Object.values(current));
    }
  }
}

function sanitizeV2Metadata(input: unknown): unknown {
  const sanitized = sanitizeRecordingPayload(input);
  if (
    typeof sanitized !== "object" ||
    sanitized === null ||
    Array.isArray(sanitized) ||
    sanitized.analysisVersion !== 2 ||
    !Array.isArray(sanitized.completions)
  ) {
    return sanitized;
  }
  for (const completion of sanitized.completions) {
    if (
      typeof completion !== "object" ||
      completion === null ||
      Array.isArray(completion) ||
      typeof completion.provenance !== "object" ||
      completion.provenance === null ||
      Array.isArray(completion.provenance) ||
      !("sanitizedProviderMetadata" in completion.provenance)
    ) {
      continue;
    }
    completion.provenance.sanitizedProviderMetadata =
      sanitizeProviderMetadata(
        completion.provenance.sanitizedProviderMetadata,
      );
  }
  return sanitized;
}

function sanitizedV2Ledger(input: unknown): AnalysisPackageV2 {
  const sanitized = sanitizeV2Metadata(input);
  assertNoEmbeddedImagePayloads(sanitized);
  return AnalysisPackageV2Schema.parse(sanitized);
}

function assertSanitizedCompletionMetadata(ledger: AnalysisPackageV2): void {
  for (const completion of ledger.completions) {
    if (
      completion.provenance.kind !== "composite" ||
      completion.provenance.sanitizedProviderMetadata === undefined
    ) {
      continue;
    }
    const metadata = completion.provenance.sanitizedProviderMetadata;
    if (
      JSON.stringify(sanitizeProviderMetadata(metadata)) !==
      JSON.stringify(metadata)
    ) {
      throw new Error("Analysis ledger contains opaque provider metadata");
    }
  }
}

async function verifyCompletionArtifactSet(
  directory: string,
  artifact: CompletionArtifact,
  source: { width: number; height: number; rgba: Buffer },
): Promise<void> {
  if (artifact.provenance.kind !== "composite") {
    throw new Error("Completion artifacts require composite provenance");
  }
  const [sourceCrop] = await Promise.all([
    readVerifiedAnalysisArtifact(directory, {
      path: artifact.sourceCropPath,
      sha256: artifact.provenance.sourceCropSha256,
    }),
    readVerifiedAnalysisArtifact(directory, artifact),
    readVerifiedAnalysisArtifact(directory, {
      path: artifact.visibleMaskPath,
      sha256: artifact.provenance.visibleMaskSha256,
    }),
    readVerifiedAnalysisArtifact(directory, {
      path: artifact.generatedMaskPath,
      sha256: artifact.provenance.generatedMaskSha256,
    }),
  ]);
  let decoded: { width: number; height: number; rgba: Buffer };
  try {
    const result = await sharp(sourceCrop)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    decoded = {
      width: result.info.width,
      height: result.info.height,
      rgba: result.data,
    };
  } catch (error) {
    throw new Error(
      `Completion source crop is not a decodable image: ${artifact.sourceCropPath}`,
      { cause: error },
    );
  }
  if (
    decoded.width !== Math.round(artifact.crop.width) ||
    decoded.height !== Math.round(artifact.crop.height)
  ) {
    throw new Error(
      `Completion source crop dimensions do not match crop bounds: ${artifact.sourceCropPath}`,
    );
  }
  const left = Math.round(artifact.crop.x);
  const top = Math.round(artifact.crop.y);
  if (
    left + decoded.width > source.width ||
    top + decoded.height > source.height
  ) {
    throw new Error(
      `Completion source crop escapes canonical canvas bounds: ${artifact.sourceCropPath}`,
    );
  }
  const expected = Buffer.alloc(decoded.width * decoded.height * 4);
  for (let row = 0; row < decoded.height; row += 1) {
    const sourceOffset = ((top + row) * source.width + left) * 4;
    source.rgba.copy(
      expected,
      row * decoded.width * 4,
      sourceOffset,
      sourceOffset + decoded.width * 4,
    );
  }
  if (!decoded.rgba.equals(expected)) {
    throw new Error(
      `Completion source crop pixels do not match canonical RGBA: ${artifact.sourceCropPath}`,
    );
  }
}

async function verifyV2ArtifactSet(
  directory: string,
  ledger: AnalysisPackageV2,
): Promise<void> {
  const sourceRgba = await readVerifiedAnalysisArtifact(directory, ledger.source);
  const source = {
    width: ledger.canvas.width,
    height: ledger.canvas.height,
    rgba: sourceRgba,
  };
  await Promise.all([
    readVerifiedAnalysisArtifact(directory, ledger.ocr),
    readVerifiedAnalysisArtifact(directory, ledger.scene),
    ...ledger.refinements.map((artifact) =>
      readVerifiedAnalysisArtifact(directory, artifact),
    ),
    ...ledger.completions.map((artifact) =>
      verifyCompletionArtifactSet(directory, artifact, source),
    ),
  ]);
}

export async function writeAnalysisPackageV2(input: {
  directory: string;
  canvas: SourceCanvas;
  ocr: OcrResult;
  scene: SceneGraph;
  refinements: AnalysisArtifact[];
  completions: CompletionArtifact[];
  ledger: AnalysisPackageV2;
}): Promise<void> {
  const directory = await requireRootDirectory(input.directory);
  const ledgerPath = resolve(directory, ANALYSIS_LEDGER_NAME);
  try {
    await lstat(ledgerPath);
    throw new Error("Analysis package is already published");
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const parsedOcr = OcrResultSchema.parse(input.ocr);
  const parsedScene = SceneGraphSchema.parse(input.scene);
  const ledger = sanitizedV2Ledger(input.ledger);
  const parsedRefinements = z.array(AnalysisArtifactSchema).parse(input.refinements);
  const parsedCompletions = z.array(CompletionArtifactSchema).parse(
    (sanitizeV2Metadata({
      analysisVersion: 2,
      completions: input.completions,
    }) as { completions: unknown }).completions,
  );
  if (comparable(ledger.refinements) !== comparable(parsedRefinements)) {
    throw new Error("Analysis ledger refinements do not match package inputs");
  }
  if (comparable(ledger.completions) !== comparable(parsedCompletions)) {
    throw new Error("Analysis ledger completions do not match package inputs");
  }
  if (
    input.canvas.width !== ledger.canvas.width ||
    input.canvas.height !== ledger.canvas.height ||
    parsedScene.canvas.width !== ledger.canvas.width ||
    parsedScene.canvas.height !== ledger.canvas.height
  ) {
    throw new Error("Analysis package canvas dimensions do not match");
  }
  if (input.canvas.rgba.length !== ledger.canvas.width * ledger.canvas.height * 4) {
    throw new Error("Canonical RGBA length does not match the analysis canvas");
  }
  if (
    input.canvas.format !== ledger.source.format ||
    sha256(input.canvas.rgba) !== ledger.source.sha256 ||
    sha256(input.canvas.sourceBytes) !== ledger.source.originalSha256
  ) {
    throw new Error("Analysis source metadata does not match the source canvas");
  }

  await Promise.all([
    ...ledger.refinements.map((artifact) =>
      readVerifiedAnalysisArtifact(directory, artifact),
    ),
    ...ledger.completions.map((artifact) => {
      if (artifact.provenance.kind !== "composite") {
        throw new Error("Completion artifacts require composite provenance");
      }
      if (artifact.provenance.assetSha256 !== artifact.sha256) {
        throw new Error(`Completion provenance hash mismatch: ${artifact.path}`);
      }
      return verifyCompletionArtifactSet(directory, artifact, input.canvas);
    }),
  ]);

  await writePrivateArtifact(resolve(directory, ledger.source.path), input.canvas.rgba);
  await Promise.all([
    writeRecording(resolve(directory, ledger.ocr.path), parsedOcr),
    writeRecording(resolve(directory, ledger.scene.path), parsedScene),
  ]);
  const [writtenOcr, writtenScene] = await Promise.all([
    readVerifiedAnalysisArtifact(directory, ledger.ocr),
    readVerifiedAnalysisArtifact(directory, ledger.scene),
  ]);
  OcrResultSchema.parse(JSON.parse(writtenOcr.toString("utf8")));
  SceneGraphSchema.parse(JSON.parse(writtenScene.toString("utf8")));
  await writeRecording(ledgerPath, ledger);
}

export async function readAnalysisPackage(
  directory: string,
): Promise<AnalysisPackageV1 | AnalysisPackageV2> {
  const ledgerBytes = await readRegularArtifact(directory, ANALYSIS_LEDGER_NAME);
  let payload: unknown;
  try {
    payload = JSON.parse(ledgerBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Analysis ledger is not valid JSON", { cause: error });
  }
  if (typeof payload !== "object" || payload === null || !("analysisVersion" in payload)) {
    throw new Error("Analysis ledger does not declare an analysisVersion");
  }

  if (payload.analysisVersion === 1) {
    const ledger = AnalysisPackageV1Schema.parse(payload);
    const [ocrBytes, visionBytes] = await Promise.all([
      readVerifiedAnalysisArtifact(directory, {
        path: ledger.outputs.ocr,
        sha256: ledger.hashes.ocr,
      }),
      readVerifiedAnalysisArtifact(directory, {
        path: ledger.outputs.vision,
        sha256: ledger.hashes.vision,
      }),
    ]);
    OcrResultSchema.parse(JSON.parse(ocrBytes.toString("utf8")));
    VisionResultSchema.parse(JSON.parse(visionBytes.toString("utf8")));
    return ledger;
  }

  if (payload.analysisVersion === 2) {
    const providerSanitized = sanitizeProviderRecording(payload, "").payload;
    if (JSON.stringify(providerSanitized) !== JSON.stringify(payload)) {
      throw new Error("Analysis ledger contains unsanitized secret-like metadata");
    }
    const ledger = AnalysisPackageV2Schema.parse(payload);
    assertSanitizedCompletionMetadata(ledger);
    assertNoEmbeddedImagePayloads(ledger);
    await verifyV2ArtifactSet(directory, ledger);
    const [source, ocrBytes, sceneBytes] = await Promise.all([
      readVerifiedAnalysisArtifact(directory, ledger.source),
      readVerifiedAnalysisArtifact(directory, ledger.ocr),
      readVerifiedAnalysisArtifact(directory, ledger.scene),
    ]);
    if (source.length !== ledger.canvas.width * ledger.canvas.height * 4) {
      throw new Error("Canonical RGBA length does not match the analysis canvas");
    }
    OcrResultSchema.parse(JSON.parse(ocrBytes.toString("utf8")));
    const scene = SceneGraphSchema.parse(JSON.parse(sceneBytes.toString("utf8")));
    if (
      scene.canvas.width !== ledger.canvas.width ||
      scene.canvas.height !== ledger.canvas.height
    ) {
      throw new Error("Scene graph canvas does not match the analysis package");
    }
    return ledger;
  }

  throw new Error(`Unsupported analysisVersion: ${String(payload.analysisVersion)}`);
}
