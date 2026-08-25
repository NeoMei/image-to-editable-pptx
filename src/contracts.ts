import { z } from "zod";

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
