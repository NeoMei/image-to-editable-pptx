import { z } from "zod";

import type { BBox } from "../contracts.js";
import {
  CanvasSizeSchema,
  NormalizedBBoxSchema,
  type CanvasSize,
  type NormalizedBBox,
} from "./contracts.js";

export function createBBoxSchema(canvas: CanvasSize): z.ZodType<BBox> {
  const owningCanvas = CanvasSizeSchema.parse(canvas);
  return z
    .object({
      x: z.number().finite().min(0).max(owningCanvas.width),
      y: z.number().finite().min(0).max(owningCanvas.height),
      width: z.number().finite().positive().max(owningCanvas.width),
      height: z.number().finite().positive().max(owningCanvas.height),
    })
    .superRefine((bbox, context) => {
      if (bbox.x + bbox.width > owningCanvas.width) {
        context.addIssue({
          code: "custom",
          message: `x + width must not exceed ${owningCanvas.width}`,
          path: ["width"],
        });
      }
      if (bbox.y + bbox.height > owningCanvas.height) {
        context.addIssue({
          code: "custom",
          message: `y + height must not exceed ${owningCanvas.height}`,
          path: ["height"],
        });
      }
    });
}

export function toPixelBBox(
  bbox: NormalizedBBox,
  canvas: CanvasSize,
): BBox {
  const normalized = NormalizedBBoxSchema.parse(bbox);
  const owningCanvas = CanvasSizeSchema.parse(canvas);
  const x = Math.min(
    owningCanvas.width - 1,
    Math.round(normalized.x * owningCanvas.width),
  );
  const y = Math.min(
    owningCanvas.height - 1,
    Math.round(normalized.y * owningCanvas.height),
  );
  const right = Math.max(
    x + 1,
    Math.min(
      owningCanvas.width,
      Math.round((normalized.x + normalized.width) * owningCanvas.width),
    ),
  );
  const bottom = Math.max(
    y + 1,
    Math.min(
      owningCanvas.height,
      Math.round((normalized.y + normalized.height) * owningCanvas.height),
    ),
  );

  return createBBoxSchema(owningCanvas).parse({
    x,
    y,
    width: right - x,
    height: bottom - y,
  });
}
