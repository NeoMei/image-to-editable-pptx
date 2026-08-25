import OpenAI from "openai";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  VisionResultSchema,
  type VisionResult,
} from "../contracts.js";
import type { ProviderResponseObserver } from "./response-observer.js";

const WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const NORMALIZED_COORDINATE_MAX = 1000;
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

const NormalizedCoordinateSchema = z.number().finite();
const NormalizedBBoxSchema = z
  .tuple([
    NormalizedCoordinateSchema,
    NormalizedCoordinateSchema,
    NormalizedCoordinateSchema,
    NormalizedCoordinateSchema,
  ])
  .refine(
    ([x1, y1, x2, y2]) => x2 > x1 && y2 > y1,
    "x2/y2 must exceed x1/y1",
  );

const VisionPayloadSchema = z.object({
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
      bbox: NormalizedBBoxSchema,
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

const VISION_PROMPT = `Analyze this slide and return JSON only, with no prose or Markdown.
The source canvas is exactly 1280 x 720 pixels.
Return {"elements":[...]} and use this exact element type enum:
text | panel | shape | icon | illustration | photo | background
For every element return type, bbox as [x1,y1,x2,y2], label, zIndex, editableAs, and confidence.
editableAs must be one of: text | native-shape | bitmap | background.
Optional visual hints are fillColor, strokeColor, and cornerRadius.
Use Qwen3-VL normalized integer coordinates from 0 to 999 for bbox, not source pixels.
x2/y2 must exceed x1/y1.
OCR is authoritative for text: do not duplicate OCR text as graphical assets.`;

function requireSafeCompatibleBase(config: AppConfig): string {
  if (!WORKSPACE_ID_PATTERN.test(config.workspaceId)) {
    throw new Error("Expected a safe Alibaba China compatible base URL");
  }

  const expectedHostname =
    `${config.workspaceId}.cn-beijing.maas.aliyuncs.com`.toLowerCase();
  const expectedHref = `https://${expectedHostname}/compatible-mode/v1`;

  let url: URL;
  try {
    url = new URL(config.dashscopeCompatibleBase);
  } catch {
    throw new Error("Expected a safe Alibaba China compatible base URL");
  }

  if (
    url.href !== expectedHref ||
    url.protocol !== "https:" ||
    url.hostname !== expectedHostname ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/compatible-mode/v1" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Expected a safe Alibaba China compatible base URL");
  }

  return expectedHref;
}

function stripSingleOuterFence(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(
    trimmed,
  );
  return fenced?.[1]?.trim() ?? trimmed;
}

export function parseQwenVisionContent(content: string): VisionResult {
  let payload: unknown;

  try {
    payload = JSON.parse(stripSingleOuterFence(content));
  } catch (error) {
    throw new Error("Qwen vision response is not valid JSON", { cause: error });
  }

  let parsed: z.infer<typeof VisionPayloadSchema>;
  try {
    parsed = VisionPayloadSchema.parse(payload);
  } catch (error) {
    throw new Error("Invalid Qwen vision response", { cause: error });
  }

  const elements = parsed.elements.map(({ bbox, ...element }) => {
    const left = Math.round(
      (bbox[0] / NORMALIZED_COORDINATE_MAX) * CANVAS_WIDTH,
    );
    const top = Math.round(
      (bbox[1] / NORMALIZED_COORDINATE_MAX) * CANVAS_HEIGHT,
    );
    const right = Math.max(
      left + 1,
      Math.round((bbox[2] / NORMALIZED_COORDINATE_MAX) * CANVAS_WIDTH),
    );
    const bottom = Math.max(
      top + 1,
      Math.round((bbox[3] / NORMALIZED_COORDINATE_MAX) * CANVAS_HEIGHT),
    );

    return {
      ...element,
      bbox: {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
    };
  });

  try {
    return VisionResultSchema.parse({ elements });
  } catch (error) {
    throw new Error("Invalid Qwen vision response", { cause: error });
  }
}

export async function analyzeElements(
  image: Buffer,
  config: AppConfig,
  observer?: ProviderResponseObserver,
): Promise<VisionResult> {
  const baseURL = requireSafeCompatibleBase(config);
  let outerHttpParseError: Error | undefined;
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
    fetch: async (input, init) => {
      const response = await fetch(input, {
        ...init,
        redirect: "error",
      });
      const responseBody = await response.clone().text();
      try {
        JSON.parse(responseBody);
      } catch (cause) {
        outerHttpParseError = new Error(
          "Qwen Vision HTTP response is not valid JSON",
          { cause },
        );
        await observer?.recordRawHttpResponse(responseBody);
        await observer?.recordParseError(outerHttpParseError);
      }
      return response;
    },
  });

  const completion = await client.chat.completions
    .create({
      model: config.visionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${image.toString("base64")}`,
              },
            },
          ],
        },
      ],
    })
    .catch((error: unknown) => {
      if (outerHttpParseError !== undefined) throw outerHttpParseError;
      throw error;
    });

  if (outerHttpParseError !== undefined) throw outerHttpParseError;

  await observer?.recordRawResponse(completion);
  try {
    const content = completion.choices[0]?.message.content;
    if (typeof content !== "string") {
      throw new Error("Qwen vision response did not contain text content");
    }

    return parseQwenVisionContent(content);
  } catch (error) {
    await observer?.recordParseError(error);
    throw error;
  }
}
