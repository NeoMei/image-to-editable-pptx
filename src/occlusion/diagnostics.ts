import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { CompletionOutcome } from "./contracts.js";

export const COMPLETION_DIAGNOSTICS_NAME = "completion-diagnostics.json";

export const CompletionReasonSchema = z.enum([
  "insufficient_evidence",
  "ambiguous_appearance",
  "geometry",
  "residual_occluder",
  "seam_mismatch",
  "contour_mismatch",
  "disabled",
  "provider_failure",
  "invalid_metadata",
  "invariant_failure",
]);

const BoundedCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const QualityMetricsSchema = z.object({
  rearSamples: BoundedCountSchema,
  frontSamples: BoundedCountSchema,
  backgroundSamples: BoundedCountSchema,
  generatedPixels: BoundedCountSchema,
  residualPixels: BoundedCountSchema,
  seamMaxDelta: z.number().finite().min(0).max(255),
  returnedOutsideChangedPixels: BoundedCountSchema,
  returnedVisibleChangedPixels: BoundedCountSchema,
}).strict();

const CompletionOutcomeDiagnosticSchema = z.union([
  z.object({
    status: z.literal("accepted"),
    metrics: QualityMetricsSchema,
  }).strict(),
  z.object({
    status: z.enum(["skipped", "rejected"]),
    reason: CompletionReasonSchema,
    metrics: QualityMetricsSchema.optional(),
  }).strict(),
]);

const CompletionDiagnosticSchema = z.union([
  z.object({
    sequence: BoundedCountSchema,
    status: z.literal("accepted"),
    metrics: QualityMetricsSchema,
  }).strict(),
  z.object({
    sequence: BoundedCountSchema,
    status: z.enum(["skipped", "rejected"]),
    reason: CompletionReasonSchema,
    metrics: QualityMetricsSchema.optional(),
  }).strict(),
]);

export const CompletionDiagnosticsSchema = z.object({
  version: z.literal(1),
  candidates: z.array(CompletionDiagnosticSchema),
}).strict();

export type CompletionDiagnostics = z.infer<typeof CompletionDiagnosticsSchema>;
export type CompletionDiagnostic = CompletionDiagnostics["candidates"][number];

export function assertValidCompletionOutcome(outcome: CompletionOutcome): void {
  CompletionOutcomeDiagnosticSchema.parse(
    outcome.status === "accepted"
      ? { status: outcome.status, metrics: outcome.metrics }
      : {
        status: outcome.status,
        reason: outcome.reason,
        ...(outcome.metrics === undefined ? {} : { metrics: outcome.metrics }),
      },
  );
}

export function completionDiagnostic(
  sequence: number,
  outcome: CompletionOutcome,
): CompletionDiagnostic {
  assertValidCompletionOutcome(outcome);
  return CompletionDiagnosticSchema.parse(
    outcome.status === "accepted"
      ? { sequence, status: outcome.status, metrics: outcome.metrics }
      : {
        sequence,
        status: outcome.status,
        reason: outcome.reason,
        ...(outcome.metrics === undefined ? {} : { metrics: outcome.metrics }),
      },
  );
}

export async function writeCompletionDiagnostics(
  directory: string,
  diagnostics: CompletionDiagnostics,
): Promise<void> {
  const parsed = CompletionDiagnosticsSchema.parse(diagnostics);
  const root = await lstat(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("Completion diagnostics require a regular analysis directory");
  }
  const path = join(directory, COMPLETION_DIAGNOSTICS_NAME);
  let file;
  try {
    file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new Error("Completion diagnostics target must be exclusively created", {
      cause: error,
    });
  }
  try {
    await file.chmod(0o600);
    await file.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
