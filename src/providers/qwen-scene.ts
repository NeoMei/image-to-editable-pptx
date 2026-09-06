import OpenAI from "openai";
import sharp from "sharp";
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
import {
  mergeRefinedSubgraph,
  selectRefinementRequests,
  type RefinementResult,
} from "../scene/refine.js";
import {
  createRegionalScenePrompt,
  createScenePrompt,
} from "./qwen-scene-prompt.js";
import type { ProviderResponseObserver } from "./response-observer.js";
import { RoutingTerminalError } from "./routing.js";

const WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const PROVIDER_COORDINATE_SCALE = 1000;

const SCENE_RETRY_INSTRUCTION =
  "Your previous reply was cut off or invalid. Reply again with the complete JSON only: close every bracket and quote, keep each label under ten words, make extractionHints an array of strings (use [] when empty), and return every node and relation required by the earlier field contract.";

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

const ProviderExtractionHintsSchema = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).filter(
      (item): item is string => typeof item === "string",
    );
  }
  return [];
}, z.array(z.string()));

const ProviderConfidenceSchema = z.preprocess((value) => {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 1 &&
    value <= 100
  ) {
    return value / 100;
  }
  return value;
}, z.number().finite().min(0).max(1));

const ProviderScenePayloadSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z.string().min(1),
          role: SceneRoleSchema,
          bbox: ProviderBBoxSchema,
          confidence: ProviderConfidenceSchema,
          zIndex: z.number().int().safe().optional(),
          label: z.string(),
          extractionHints: ProviderExtractionHintsSchema,
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
          confidence: ProviderConfidenceSchema,
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

type ProviderScenePayload = z.infer<typeof ProviderScenePayloadSchema>;

function normalizeProviderRelations(
  nodes: ProviderScenePayload["nodes"],
  relations: ProviderScenePayload["relations"],
): ProviderScenePayload["relations"] {
  const roleById = new Map(nodes.map((node) => [node.id, node.role]));
  return relations.map((relation) => {
    if (relation.kind !== "carries-text") return relation;
    if (roleById.get(relation.from) === "text-backing") return relation;
    if (roleById.get(relation.to) !== "text") return relation;
    return {
      ...relation,
      kind: "belongs-to" as const,
      from: relation.to,
      to: relation.from,
    };
  });
}

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

function closersForPrefix(prefix: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < prefix.length; index += 1) {
    const char = prefix[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
  }
  let closers = inString ? '"' : "";
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    closers += stack[index] === "{" ? "}" : "]";
  }
  return closers;
}

export function* truncatedRepairCandidates(text: string): Generator<string> {
  yield text + closersForPrefix(text);
  let inString = false;
  let escaped = false;
  const elementEnds: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "}" || char === "]") {
      elementEnds.push(index + 1);
    }
  }
  for (let index = elementEnds.length - 1; index >= 0; index -= 1) {
    const candidate = text.slice(0, elementEnds[index]);
    yield candidate + closersForPrefix(candidate);
  }
}

export function parseQwenSceneContent(
  content: string,
  canvas: CanvasSize,
): SceneGraph {
  const stripped = stripSingleOuterFence(content);
  let payload: unknown;
  try {
    payload = JSON.parse(stripped);
  } catch (error) {
    let repaired: unknown;
    let repairedOk = false;
    for (const candidate of truncatedRepairCandidates(stripped)) {
      try {
        repaired = JSON.parse(candidate);
        repairedOk = true;
        break;
      } catch {
        continue;
      }
    }
    if (!repairedOk) {
      throw new Error("Qwen scene response is not valid JSON", {
        cause: error,
      });
    }
    payload = repaired;
  }

  try {
    const parsed = ProviderScenePayloadSchema.parse(payload);
    const relations = normalizeProviderRelations(
      parsed.nodes,
      parsed.relations,
    );
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
      relations,
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
  return requestSceneGraph(image, canvas, prompt, config, observer);
}

type SceneUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type SceneChatMessage =
  | { role: "user"; content: string | SceneUserContentPart[] }
  | { role: "assistant"; content: string };

function buildSceneMessages(
  prompt: string,
  image: Buffer,
): SceneChatMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64," + image.toString("base64"),
          },
        },
      ],
    },
  ];
}

async function createSceneCompletion(
  messages: SceneChatMessage[],
  config: AppConfig,
  observer?: ProviderResponseObserver,
): Promise<string | null> {
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

  observer?.recordTransportAttempt?.();
  const completion = await client.chat.completions
    .create({
      model: config.visionModel,
      messages,
    })
    .catch((error: unknown) => {
      if (outerHttpParseError !== undefined) throw outerHttpParseError;
      throw error;
    });

  if (outerHttpParseError !== undefined) throw outerHttpParseError;

  await observer?.recordRawResponse(completion);
  return completion.choices[0]?.message.content ?? null;
}

function requireSceneContent(content: string | null): string {
  if (typeof content !== "string") {
    throw new Error("Qwen scene response did not contain text content");
  }
  return content;
}

export async function requestSceneGraph(
  image: Buffer,
  canvas: CanvasSize,
  prompt: string,
  config: AppConfig,
  observer?: ProviderResponseObserver,
): Promise<SceneGraph> {
  const messages = buildSceneMessages(prompt, image);
  const firstContent = await createSceneCompletion(messages, config, observer);
  try {
    return parseQwenSceneContent(requireSceneContent(firstContent), canvas);
  } catch (firstError) {
    await observer?.recordParseError(firstError);
  }

  const retryMessages: SceneChatMessage[] = [
    ...messages,
    {
      role: "assistant",
      content: typeof firstContent === "string" ? firstContent : "",
    },
    { role: "user", content: SCENE_RETRY_INSTRUCTION },
  ];
  const retryContent = await createSceneCompletion(
    retryMessages,
    config,
    observer,
  );
  try {
    return parseQwenSceneContent(requireSceneContent(retryContent), canvas);
  } catch (retryError) {
    await observer?.recordParseError(retryError);
    throw retryError;
  }
}

export type RegionalRefinementResult = RefinementResult & {
  warnings: string[];
  effectiveModels?: string[];
};

export type SceneGraphRequester = (
  image: Buffer,
  canvas: CanvasSize,
  prompt: string,
) => Promise<{ graph: SceneGraph; model: string }>;

export async function refineSceneRegions(
  image: Buffer,
  graph: SceneGraph,
  config: AppConfig | { maxRegionAnalysis?: number },
  observer?: ProviderResponseObserver,
  requester?: SceneGraphRequester,
): Promise<RegionalRefinementResult> {
  const requests = selectRefinementRequests(
    graph,
    graph.canvas,
    config.maxRegionAnalysis ?? 8,
  );
  const warnings: string[] = [];
  SceneGraphSchema.parse(graph);
  let refinedGraph = graph;
  const effectiveModels: string[] = [];

  for (const request of requests) {
    try {
      const crop = await sharp(image)
        .extract({
          left: request.crop.x,
          top: request.crop.y,
          width: request.crop.width,
          height: request.crop.height,
        })
        .png()
        .toBuffer();
      const cropCanvas = {
        width: request.crop.width,
        height: request.crop.height,
      };
      const prompt = createRegionalScenePrompt(cropCanvas, request);
      const routed = requester === undefined
        ? {
            graph: await requestSceneGraph(
              crop,
              cropCanvas,
              prompt,
              config as AppConfig,
              observer,
            ),
            model: (config as AppConfig).visionModel,
          }
        : await requester(crop, cropCanvas, prompt);
      const localGraph = routed.graph;
      effectiveModels.push(routed.model);
      refinedGraph = mergeRefinedSubgraph(refinedGraph, request, localGraph);
    } catch (error) {
      if (error instanceof RoutingTerminalError) throw error;
      warnings.push(
        `regional_refinement_rejected:${request.reason}:${request.targetNodeIds.join(",")}`,
      );
    }
  }

  return {
    graph: refinedGraph,
    requests,
    warnings,
    ...(requester === undefined ? {} : { effectiveModels }),
  };
}
