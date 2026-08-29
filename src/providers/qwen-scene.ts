import OpenAI from "openai";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  CanvasSizeSchema,
  SceneGraphSchema,
  SceneRelationKindSchema,
  SceneRoleSchema,
  type CanvasSize,
  type SceneGraph,
  type SceneNode,
} from "../scene/contracts.js";
import type { ProviderResponseObserver } from "./response-observer.js";

const WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const PROVIDER_COORDINATE_SCALE = 1000;

const ProviderCoordinateSchema = z
  .number()
  .int()
  .finite()
  .min(0)
  .max(PROVIDER_COORDINATE_SCALE);
const ProviderBBoxSchema = z
  .tuple([
    ProviderCoordinateSchema,
    ProviderCoordinateSchema,
    ProviderCoordinateSchema,
    ProviderCoordinateSchema,
  ])
  .superRefine(([x1, y1, x2, y2], context) => {
    if (x2 <= x1) {
      context.addIssue({
        code: "custom",
        message: "x2 must exceed x1",
        path: [2],
      });
    }
    if (y2 <= y1) {
      context.addIssue({
        code: "custom",
        message: "y2 must exceed y1",
        path: [3],
      });
    }
  });

const ProviderScenePayloadSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z.string().min(1),
          role: SceneRoleSchema,
          bbox: ProviderBBoxSchema,
          confidence: z.number().finite().min(0).max(1),
          zIndex: z.number().int().safe().optional(),
          label: z.string(),
          extractionHints: z.array(z.string()),
        })
        .strict(),
    ),
    relations: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: SceneRelationKindSchema,
          from: z.string().min(1),
          to: z.string().min(1),
          confidence: z.number().finite().min(0).max(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((payload, context) => {
    for (const [index, node] of payload.nodes.entries()) {
      if (
        node.role === "background" &&
        (node.bbox[0] !== 0 ||
          node.bbox[1] !== 0 ||
          node.bbox[2] !== PROVIDER_COORDINATE_SCALE ||
          node.bbox[3] !== PROVIDER_COORDINATE_SCALE)
      ) {
        context.addIssue({
          code: "custom",
          message: "background bbox must cover the complete canvas",
          path: ["nodes", index, "bbox"],
        });
      }
    }
  });

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

function createScenePrompt(canvas: CanvasSize): string {
  const owningCanvas = CanvasSizeSchema.parse(canvas);
  return `Analyze the complete slide and return JSON only, with no prose or Markdown.
The source canvas is ${owningCanvas.width} x ${owningCanvas.height} pixels. Use it only as spatial context; do not return pixel coordinates.
Return exactly {"nodes":[...],"relations":[...]} with no additional fields.
For every node return id, role, bbox, confidence, label, extractionHints, and optional zIndex.
role must be one of: background | text | text-backing | foreground-object | connector | compound-group | decoration.
bbox must be [x1,y1,x2,y2] in normalized thousandths from 0 through 1000, where 0 is the top or left edge and 1000 is the bottom or right edge. Coordinates must be integers and x2/y2 must exceed x1/y1.
Return exactly one background node covering the complete canvas.
Identify every independently movable foreground object as its own node, even when nearby objects share a panel or visual theme.
Use compound-group only when visible connectivity or a shared contour means the parts must move together. Represent visible lines or arrows as connector nodes and describe connectivity with relations.
Use text-backing for a visible surface that carries text and link it to the text node with carries-text. OCR is authoritative for text content and geometry; Vision text labels must not replace or duplicate OCR output.
Describe partial occlusion with occludes and explicit layer order with in-front-of or behind. Do not infer hidden content that is not visible.
relation kind must be one of: belongs-to | connected-to | carries-text | occludes | in-front-of | behind.
For every relation return id, kind, from, to, and confidence, and reference only node IDs present in this response.
Labels are audit-only descriptions for human review. They must not imply extraction or planning decisions; encode decisions only with roles, relations, geometry, confidence, zIndex, and extractionHints.`;
}

export function parseQwenSceneContent(
  content: string,
  canvas: CanvasSize,
): SceneGraph {
  let payload: unknown;
  try {
    payload = JSON.parse(stripSingleOuterFence(content));
  } catch (error) {
    throw new Error("Qwen scene response is not valid JSON", { cause: error });
  }

  try {
    const parsed = ProviderScenePayloadSchema.parse(payload);
    const nodes = parsed.nodes.map(({ bbox, zIndex, ...node }): SceneNode => {
      const normalizedNode = {
        ...node,
        bbox: {
          x: bbox[0] / PROVIDER_COORDINATE_SCALE,
          y: bbox[1] / PROVIDER_COORDINATE_SCALE,
          width: (bbox[2] - bbox[0]) / PROVIDER_COORDINATE_SCALE,
          height: (bbox[3] - bbox[1]) / PROVIDER_COORDINATE_SCALE,
        },
      };
      if (zIndex === undefined) return normalizedNode;
      return {
        ...normalizedNode,
        zIndex,
      };
    });

    const graph: SceneGraph = {
      graphVersion: 1,
      canvas: CanvasSizeSchema.parse(canvas),
      nodes,
      relations: parsed.relations,
    };
    SceneGraphSchema.parse(graph);
    return graph;
  } catch (error) {
    throw new Error("Invalid Qwen scene response", { cause: error });
  }
}

export async function analyzeScene(
  image: Buffer,
  canvas: CanvasSize,
  config: AppConfig,
  observer?: ProviderResponseObserver,
): Promise<SceneGraph> {
  const prompt = createScenePrompt(canvas);
  const baseURL = requireSafeCompatibleBase(config);
  let outerHttpParseError: Error | undefined;
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, redirect: "error" });
      const responseBody = await response.clone().text();
      try {
        JSON.parse(responseBody);
      } catch (cause) {
        outerHttpParseError = new Error(
          "Qwen scene HTTP response is not valid JSON",
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
            { type: "text", text: prompt },
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
      throw new Error("Qwen scene response did not contain text content");
    }

    return parseQwenSceneContent(content, canvas);
  } catch (error) {
    await observer?.recordParseError(error);
    throw error;
  }
}
