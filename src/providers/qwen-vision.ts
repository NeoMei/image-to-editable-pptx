import OpenAI from "openai";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  VisionResultSchema,
  type VisionResult,
} from "../contracts.js";

const WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

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
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
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
The canvas is exactly 1280 x 720 pixels.
Return {"elements":[...]} and use this exact element type enum:
text | panel | shape | icon | illustration | photo | background
For every element return type, bbox as [x1,y1,x2,y2], label, zIndex, editableAs, and confidence.
editableAs must be one of: text | native-shape | bitmap | background.
Optional visual hints are fillColor, strokeColor, and cornerRadius.
Coordinates must remain inside the canvas and x2/y2 must exceed x1/y1.
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

  const elements = parsed.elements.map(({ bbox, ...element }) => ({
    ...element,
    bbox: {
      x: bbox[0],
      y: bbox[1],
      width: bbox[2] - bbox[0],
      height: bbox[3] - bbox[1],
    },
  }));

  try {
    return VisionResultSchema.parse({ elements });
  } catch (error) {
    throw new Error("Invalid Qwen vision response", { cause: error });
  }
}

export async function analyzeElements(
  image: Buffer,
  config: AppConfig,
): Promise<VisionResult> {
  const baseURL = requireSafeCompatibleBase(config);
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        redirect: "error",
      }),
  });

  const completion = await client.chat.completions.create({
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
  });

  const content = completion.choices[0]?.message.content;
  if (typeof content !== "string") {
    throw new Error("Qwen vision response did not contain text content");
  }

  return parseQwenVisionContent(content);
}
