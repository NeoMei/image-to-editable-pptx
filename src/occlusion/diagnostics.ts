import { z } from "zod";

import type { CompletionOutcome } from "./contracts.js";

const CompletionReasonSchema = z.enum([
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

const QualityMetricsSchema = z.object({
  rearSamples: z.number().int().nonnegative(),
  frontSamples: z.number().int().nonnegative(),
  backgroundSamples: z.number().int().nonnegative(),
  generatedPixels: z.number().int().nonnegative(),
  residualPixels: z.number().int().nonnegative(),
  seamMaxDelta: z.number().finite().nonnegative(),
  returnedOutsideChangedPixels: z.number().int().nonnegative(),
  returnedVisibleChangedPixels: z.number().int().nonnegative(),
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
