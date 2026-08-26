import { z } from "zod";

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const BBoxSchema = z
  .object({
    x: z.number().min(0).max(1280),
    y: z.number().min(0).max(720),
    width: z.number().positive().max(1280),
    height: z.number().positive().max(720),
  })
  .superRefine((bbox, context) => {
    if (bbox.x + bbox.width > 1280) {
      context.addIssue({
        code: "custom",
        message: "x + width must not exceed 1280",
        path: ["width"],
      });
    }

    if (bbox.y + bbox.height > 720) {
      context.addIssue({
        code: "custom",
        message: "y + height must not exceed 720",
        path: ["height"],
      });
    }
  });

export const ProviderBBoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const SlideElementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    id: z.string(),
    text: z.string(),
    bbox: BBoxSchema,
    rotation: z.number(),
    color: z.string(),
    fontSizePx: z.number().positive(),
    charSpacingPx: z.number().min(0).max(36).optional(),
    bold: z.boolean().optional(),
    align: z.enum(["left", "center", "right"]),
    zIndex: z.number().int(),
  }),
  z.object({
    kind: z.literal("shape"),
    id: z.string(),
    label: z.string(),
    shape: z.enum(["rect", "roundRect", "ellipse", "line"]),
    bbox: BBoxSchema,
    fillColor: z.string(),
    strokeColor: z.string(),
    strokeWidthPx: z.number().nonnegative(),
    cornerRadiusPx: z.number().nonnegative(),
    zIndex: z.number().int(),
  }),
  z.object({
    kind: z.literal("asset"),
    id: z.string(),
    label: z.string(),
    bbox: BBoxSchema,
    extraction: z.enum(["transparent", "rectangular"]),
    assetPath: z.string(),
    zIndex: z.number().int(),
    fallbackReason: z.string().optional(),
  }),
]);

const ProviderPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const OcrResultSchema = z.object({
  lines: z.array(
    z.object({
      text: z.string(),
      bbox: ProviderBBoxSchema,
      quad: z.tuple([
        ProviderPointSchema,
        ProviderPointSchema,
        ProviderPointSchema,
        ProviderPointSchema,
      ]),
    }),
  ),
});

export const VisionResultSchema = z.object({
  elements: z.array(
    z.object({
      type: z.enum([
        "text",
        "panel",
        "shape",
        "icon",
        "illustration",
        "photo",
        "background",
      ]),
      bbox: ProviderBBoxSchema,
      label: z.string(),
      zIndex: z.number().int(),
      editableAs: z.enum(["text", "native-shape", "bitmap", "background"]),
      confidence: z.number().min(0).max(1),
      fillColor: z.string().optional(),
      strokeColor: z.string().optional(),
      cornerRadius: z.number().nonnegative().optional(),
    }),
  ),
});

export const SlideManifestSchema = z.object({
  manifestVersion: z.literal(1),
  canvas: z.object({
    width: z.literal(1280),
    height: z.literal(720),
  }),
  elements: z.array(SlideElementSchema),
  warnings: z.array(z.string()),
});

export type BBox = z.infer<typeof BBoxSchema>;
export type ProviderBBox = z.infer<typeof ProviderBBoxSchema>;
export type SlideElement = z.infer<typeof SlideElementSchema>;
export type OcrResult = z.infer<typeof OcrResultSchema>;
export type VisionResult = z.infer<typeof VisionResultSchema>;
export type SlideManifest = z.infer<typeof SlideManifestSchema>;

export type TextSlideElement = Extract<SlideElement, { kind: "text" }>;

export type FidelityTextCandidate = {
  kind: "text";
  id: string;
  required: true;
  element: TextSlideElement;
};

export type FidelityIconCandidate = {
  kind: "icon";
  id: string;
  label: string;
  bbox: BBox;
  zIndex: number;
  sourceElementIndexes: number[];
};

export type FidelityPlan = {
  canvas: { width: 1280; height: 720 };
  text: FidelityTextCandidate[];
  icons: FidelityIconCandidate[];
  warnings: string[];
};

export type LocalRepairReason =
  | "mask_empty"
  | "surface_samples_insufficient"
  | "surface_variance_too_high"
  | "filled_pixels_too_different";

export type LocalRepairMetrics = {
  maskedPixels: number;
  outsideMaskChangedPixels: number;
  ringSamples: number;
  ringChannelMad: number;
  filledPixelDistanceP95: number;
};

export type LocalRepairResult = {
  image: Buffer;
  accepted: boolean;
  metrics: LocalRepairMetrics;
  reason?: LocalRepairReason;
};

export type RecompositionOptions = {
  source: Buffer;
  background: Buffer;
  asset: Buffer;
  bbox: BBox;
  ignoredMask?: Buffer;
};

export type RecompositionMetrics = {
  comparedPixels: number;
  meanAbsoluteError: number;
  p95ChannelDelta: number;
  changedPixelRatio: number;
};

export type RecompositionResult = {
  accepted: boolean;
  preview: Buffer;
  metrics: RecompositionMetrics;
  reason?: "recomposition_mismatch";
};

export const CandidateDecisionSchema = z.object({
  candidateId: z.string().min(1),
  kind: z.enum(["text", "icon"]),
  decision: z.enum(["accepted", "kept_in_background"]),
  bbox: BBoxSchema,
  sourceElementIndexes: z.array(z.number().int().nonnegative()),
  repairMethod: z.enum(["local_nearest_surface", "none"]),
  extraction: z.enum(["transparent", "none"]),
  reason: z.enum([
    "edge_colors_inconsistent",
    "filled_pixels_too_different",
    "local_repair_failed",
    "mask_empty",
    "opaque_border_ratio_above_2_percent",
    "ocr_text_overlap_above_1_percent",
    "recomposition_mismatch",
    "surface_samples_insufficient",
    "surface_variance_too_high",
    "transparent_extraction_failed",
    "transparent_pixel_ratio_above_92_percent",
    "transparent_pixel_ratio_below_5_percent",
  ]).optional(),
  repairMetrics: z.object({
    maskedPixels: z.number().int().nonnegative(),
    outsideMaskChangedPixels: z.number().int().nonnegative(),
    ringSamples: z.number().int().nonnegative(),
    ringChannelMad: z.number().nonnegative(),
    filledPixelDistanceP95: z.number().nonnegative(),
  }).optional(),
  recompositionMetrics: z.object({
    comparedPixels: z.number().int().nonnegative(),
    meanAbsoluteError: z.number().nonnegative(),
    p95ChannelDelta: z.number().nonnegative(),
    changedPixelRatio: z.number().min(0).max(1),
  }).optional(),
  output: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("editable_layer"),
      manifestElementId: z.string().min(1),
      assetPath: z.string().min(1).optional(),
    }),
    z.object({ state: z.literal("kept_in_background") }),
  ]),
});

export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;

export const RunLedgerV2Schema = z.object({
  ledgerVersion: z.literal(2),
  mode: z.enum(["live", "replay"]),
  recorded: z.boolean(),
  models: z.object({
    ocr: z.string().min(1),
    vision: z.string().min(1),
    edit: z.string().min(1).optional(),
  }),
  durationsMs: z.object({
    ocr: z.number().finite().nonnegative(),
    vision: z.number().finite().nonnegative(),
    analyze: z.number().finite().nonnegative(),
    plan: z.number().finite().nonnegative(),
    repair: z.number().finite().nonnegative(),
    export: z.number().finite().nonnegative(),
    total: z.number().finite().nonnegative(),
  }),
  taskIds: z.object({
    wanx: z.string().min(1).optional(),
  }).strict(),
  warnings: z.array(z.string()),
  decisions: z.array(CandidateDecisionSchema),
  hashes: z.object({
    sourceImage: Sha256Schema,
    ocr: Sha256Schema,
    vision: Sha256Schema,
    analysisLedger: Sha256Schema,
    manifest: Sha256Schema,
    removalMask: Sha256Schema,
    cleanBackground: Sha256Schema,
    assets: z.record(z.string(), Sha256Schema),
    pptx: Sha256Schema,
  }),
  outputs: z.object({
    directory: z.string().min(1),
    ocr: z.string().min(1),
    vision: z.string().min(1),
    analysisLedger: z.string().min(1),
    manifest: z.string().min(1),
    removalMask: z.string().min(1),
    cleanBackground: z.string().min(1),
    assets: z.string().min(1),
    pptx: z.string().min(1),
  }),
});

export type RunLedgerV2 = z.infer<typeof RunLedgerV2Schema>;
