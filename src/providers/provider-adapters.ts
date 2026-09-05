import { createHash } from "node:crypto";

import { APIConnectionError, APIError } from "openai";
import sharp from "sharp";

import type { AppConfig, RoutedProviderConfig } from "../config.js";
import { OcrResultSchema, type OcrResult } from "../contracts.js";
import type { OcclusionCompletionProvider } from "../occlusion/contracts.js";
import {
  CanvasSizeSchema,
  type CanvasSize,
  type SceneGraph,
} from "../scene/contracts.js";
import type { FileHostBridge, HostProvider } from "./host-bridge.js";
import { validatedHostResult } from "./host-bridge.js";
import { parseQwenSceneContent } from "./qwen-scene.js";
import { recognizeText } from "./qwen-ocr.js";
import { requestSceneGraph } from "./qwen-scene.js";
import { createWanxOcclusionCompletionProvider } from "./wanx-edit.js";
import {
  ProviderFailure,
  type ProviderExecution,
} from "./routing.js";
import type { ProviderResponseObserver } from "./response-observer.js";

export type AnalysisAdapterInput = Readonly<{
  image: Buffer;
  canvas: CanvasSize;
  prompt?: string;
}>;

export type CompletionAdapterInput = Readonly<{
  image: Buffer;
  canvas: CanvasSize;
  prompt: string;
  hiddenMask: Buffer;
  protectedMask: Buffer;
}>;

export type CompletionAdapterValue = Awaited<
  ReturnType<OcclusionCompletionProvider["complete"]>
>;

export type ProviderOperationExecutors = Readonly<{
  ocr?: (input: AnalysisAdapterInput) => Promise<ProviderExecution<OcrResult>>;
  scene?: (
    input: AnalysisAdapterInput & { prompt: string },
  ) => Promise<ProviderExecution<SceneGraph>>;
  completion?: (
    input: CompletionAdapterInput,
  ) => Promise<ProviderExecution<CompletionAdapterValue>>;
}>;

export type ApiAdapterOptions = RoutedProviderConfig & Readonly<{
  requestTimeoutMs: number;
  maxAttempts: number;
  fetch?: typeof fetch;
  onTransportAttempt?: (attempt: number) => void;
}>;

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";
const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";
const GEMINI_POLICY_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "ESCALATION",
]);
const GEMINI_ANALYSIS_SUCCESS_FINISH_REASONS = new Set(["STOP"]);
const GEMINI_COMPLETION_SUCCESS_FINISH_REASONS = new Set(["STOP", "MAX_TOKENS"]);

function failure(
  status: ConstructorParameters<typeof ProviderFailure>[0],
): ProviderExecution<never> {
  return { ok: false, failure: new ProviderFailure(status, status) };
}

function success<T>(model: string, value: T): ProviderExecution<T> {
  return { ok: true, validated: true, model, value };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function containsOpenAiPolicyRefusal(payload: unknown): boolean {
  const pending: unknown[] = [payload];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = object(current);
    if (record === undefined) continue;
    if (
      record.type === "refusal" ||
      record.code === "moderation_blocked" ||
      record.reason === "moderation_blocked" ||
      record.code === "content_filter" ||
      record.reason === "content_filter"
    ) return true;
    pending.push(...Object.values(record));
  }
  return false;
}

export function containsGeminiPolicyRefusal(payload: unknown): boolean {
  const pending: unknown[] = [payload];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = object(current);
    if (record === undefined) continue;
    if (
      (typeof record.finishReason === "string" && GEMINI_POLICY_FINISH_REASONS.has(record.finishReason)) ||
      (typeof record.blockReason === "string" && record.blockReason !== "BLOCK_REASON_UNSPECIFIED")
    ) return true;
    pending.push(...Object.values(record));
  }
  return false;
}

function classifyHttp(status: number): "auth_unavailable" | "unavailable" | "retry" | "invalid_input" {
  if (status === 401 || status === 403) return "auth_unavailable";
  if (status === 404) return "unavailable";
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return "retry";
  }
  return "invalid_input";
}

type ParsedHttp = Readonly<{ response: Response; text: string; payload?: unknown }>;

async function requestWithRetries(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  options: {
    requestTimeoutMs: number;
    maxAttempts: number;
    policy: (value: unknown) => boolean;
    onTransportAttempt?: (attempt: number) => void;
  },
): Promise<ProviderExecution<ParsedHttp>> {
  const attempts = Math.max(1, Math.min(3, Math.trunc(options.maxAttempts)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.onTransportAttempt?.(attempt);
    let response: Response;
    try {
      response = await fetcher(input, {
        ...init,
        signal: AbortSignal.timeout(options.requestTimeoutMs),
        redirect: "error",
      });
    } catch {
      if (attempt === attempts) return failure("retryable_exhausted");
      continue;
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (attempt === attempts) return failure("retryable_exhausted");
      continue;
    }
    const payload = safeJson(text);
    if (options.policy(payload)) return failure("policy_refused");
    if (response.ok) return success("http", { response, text, ...(payload === undefined ? {} : { payload }) });
    const classification = classifyHttp(response.status);
    if (classification === "retry") {
      if (attempt === attempts) return failure("retryable_exhausted");
      continue;
    }
    return failure(classification);
  }
  return failure("retryable_exhausted");
}

function validateOcr(value: unknown, canvas: CanvasSize): OcrResult {
  const parsed = OcrResultSchema.parse(value);
  for (const line of parsed.lines) {
    const right = line.bbox.x + line.bbox.width;
    const bottom = line.bbox.y + line.bbox.height;
    if (
      line.bbox.x < 0 || line.bbox.y < 0 ||
      right > canvas.width || bottom > canvas.height ||
      line.quad.some((point) =>
        point.x < 0 || point.y < 0 || point.x > canvas.width || point.y > canvas.height)
    ) throw new Error("OCR geometry escapes the source canvas");
  }
  return parsed;
}

export function parseValidatedOcrText(text: string, canvas: CanvasSize): OcrResult {
  const payload = safeJson(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""));
  if (payload === undefined) throw new Error("OCR response is not JSON");
  return validateOcr(payload, CanvasSizeSchema.parse(canvas));
}

export function openAiText(payload: unknown): string | undefined {
  const root = object(payload);
  const output = root?.output;
  if (!Array.isArray(output)) return undefined;
  const texts: string[] = [];
  for (const item of output) {
    const content = object(item)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const record = object(part);
      if (record?.type === "output_text" && typeof record.text === "string") {
        texts.push(record.text);
      }
    }
  }
  return texts.length === 0 ? undefined : texts.join("\n");
}

function effectiveOpenAiModel(payload: unknown, configured: string): string {
  const model = object(payload)?.model;
  return typeof model === "string" && model.length > 0 ? model : configured;
}

function openAiAnalysisBody(model: string, prompt: string, image: Buffer): string {
  return JSON.stringify({
    model,
    input: [{ role: "user", content: [
      { type: "input_text", text: prompt },
      { type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}` },
    ] }],
  });
}

const OCR_PROMPT = `Return JSON only as {"lines":[...]}. Each line must contain text, a pixel bbox {x,y,width,height}, and quad with four pixel {x,y} points. Coordinates must be finite and inside the supplied canvas.`;

const MIN_OPENAI_IMAGE_PIXELS = 655_360;
const MAX_OPENAI_IMAGE_PIXELS = 8_294_400;
const MAX_IMAGE_EDGE = 3_840;
const MAX_GENERATED_IMAGE_BYTES = 64 * 1024 * 1024;

type PreparedCompletion = Readonly<{
  image: Buffer;
  hiddenMask: Buffer;
  protectedMask: Buffer;
  canvas: CanvasSize;
  crop: { left: number; top: number; width: number; height: number };
}>;

function selectCompletionCanvas(canvas: CanvasSize): CanvasSize {
  let best: { width: number; height: number; area: number; ratioError: number } | undefined;
  const targetRatio = canvas.width / canvas.height;
  for (let width = Math.ceil(canvas.width / 16) * 16; width <= MAX_IMAGE_EDGE; width += 16) {
    const minimumHeight = Math.max(canvas.height, Math.ceil(MIN_OPENAI_IMAGE_PIXELS / width));
    const height = Math.ceil(minimumHeight / 16) * 16;
    if (height > MAX_IMAGE_EDGE) continue;
    const area = width * height;
    if (area < MIN_OPENAI_IMAGE_PIXELS || area > MAX_OPENAI_IMAGE_PIXELS) continue;
    if (Math.max(width / height, height / width) > 3) continue;
    const candidate = { width, height, area, ratioError: Math.abs(width / height - targetRatio) };
    if (
      best === undefined ||
      candidate.ratioError < best.ratioError - 1e-9 ||
      (Math.abs(candidate.ratioError - best.ratioError) < 1e-9 && candidate.area < best.area)
    ) best = candidate;
  }
  if (best === undefined) throw new Error("Completion crop cannot fit a supported image canvas");
  return { width: best.width, height: best.height };
}

async function padMask(
  mask: Buffer,
  crop: PreparedCompletion["crop"],
  canvas: CanvasSize,
  outside: number,
): Promise<Buffer> {
  const metadata = await sharp(mask).metadata();
  const pixels = metadata.hasAlpha
    ? sharp(mask).extractChannel("alpha")
    : sharp(mask).greyscale();
  const decoded = await pixels.raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== crop.width || decoded.info.height !== crop.height) {
    throw new Error("Completion mask geometry does not match the crop");
  }
  const padded = Buffer.alloc(canvas.width * canvas.height, outside);
  for (let row = 0; row < crop.height; row += 1) {
    decoded.data.copy(
      padded,
      (crop.top + row) * canvas.width + crop.left,
      row * crop.width,
      (row + 1) * crop.width,
    );
  }
  return sharp(padded, { raw: { width: canvas.width, height: canvas.height, channels: 1 } }).png().toBuffer();
}

async function openAiAlphaMask(
  hiddenMask: Buffer,
  crop: PreparedCompletion["crop"],
  canvas: CanvasSize,
): Promise<Buffer> {
  const grayscale = await padMask(hiddenMask, crop, canvas, 0);
  const decoded = await sharp(grayscale).greyscale().raw().toBuffer();
  const rgba = Buffer.alloc(decoded.length * 4, 255);
  for (let index = 0; index < decoded.length; index += 1) {
    const x = index % canvas.width;
    const y = Math.floor(index / canvas.width);
    const inside = x >= crop.left && x < crop.left + crop.width && y >= crop.top && y < crop.top + crop.height;
    rgba[index * 4 + 3] = inside && decoded[index]! >= 128 ? 0 : 255;
  }
  return sharp(rgba, { raw: { width: canvas.width, height: canvas.height, channels: 4 } }).png().toBuffer();
}

export async function prepareCompletion(input: CompletionAdapterInput): Promise<PreparedCompletion> {
  CanvasSizeSchema.parse(input.canvas);
  const source = await sharp(input.image).metadata();
  if (source.width !== input.canvas.width || source.height !== input.canvas.height) {
    throw new Error("Completion source geometry does not match the crop");
  }
  const canvas = selectCompletionCanvas(input.canvas);
  const crop = {
    left: Math.floor((canvas.width - input.canvas.width) / 2),
    top: Math.floor((canvas.height - input.canvas.height) / 2),
    width: input.canvas.width,
    height: input.canvas.height,
  };
  const image = await sharp(input.image)
    .extend({
      left: crop.left,
      right: canvas.width - crop.width - crop.left,
      top: crop.top,
      bottom: canvas.height - crop.height - crop.top,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return {
    image,
    hiddenMask: await openAiAlphaMask(input.hiddenMask, crop, canvas),
    protectedMask: await padMask(input.protectedMask, crop, canvas, 0),
    canvas,
    crop,
  };
}

export function paddedCompletionPrompt(
  prompt: string,
  prepared: PreparedCompletion,
): string {
  const { left, top, width, height } = prepared.crop;
  return `${prompt}\nThe original crop occupies x=${left}, y=${top}, width=${width}, height=${height} on the supplied padded canvas. Treat transparent padding as protected context and edit only the hidden-mask region.`;
}

export async function normalizeGeneratedImage(
  image: Buffer,
  mimeType: string,
  prepared: PreparedCompletion,
): Promise<Buffer> {
  if (image.length === 0 || image.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error("Generated image exceeds the safe size limit");
  }
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new Error("Generated image MIME type is unsupported");
  }
  const metadata = await sharp(image, { limitInputPixels: MAX_IMAGE_EDGE * MAX_IMAGE_EDGE * 4 }).metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error("Generated image has no geometry");
  }
  const decodedMimeType = metadata.format === "png"
    ? "image/png"
    : metadata.format === "jpeg"
      ? "image/jpeg"
      : undefined;
  if (decodedMimeType !== mimeType) {
    throw new Error("Generated image MIME type does not match its bytes");
  }
  let normalized = image;
  if (metadata.width !== prepared.canvas.width || metadata.height !== prepared.canvas.height) {
    const sourceRatio = metadata.width / metadata.height;
    const targetRatio = prepared.canvas.width / prepared.canvas.height;
    if (Math.abs(sourceRatio - targetRatio) / targetRatio > 0.001) {
      throw new Error("Generated image has incompatible geometry");
    }
    normalized = await sharp(image)
      .resize(prepared.canvas.width, prepared.canvas.height, { fit: "fill" })
      .png()
      .toBuffer();
  }
  return sharp(normalized)
    .extract(prepared.crop)
    .png()
    .toBuffer();
}

export function createOpenAiExecutors(options: ApiAdapterOptions): ProviderOperationExecutors {
  const fetcher = options.fetch ?? fetch;
  const analyze = async <T>(
    input: AnalysisAdapterInput,
    prompt: string,
    parse: (text: string) => T,
  ): Promise<ProviderExecution<T>> => {
    const result = await requestWithRetries(fetcher, OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: openAiAnalysisBody(options.analysisModel, prompt, input.image),
    }, {
      requestTimeoutMs: options.requestTimeoutMs,
      maxAttempts: options.maxAttempts,
      policy: containsOpenAiPolicyRefusal,
      ...(options.onTransportAttempt === undefined
        ? {}
        : { onTransportAttempt: options.onTransportAttempt }),
    });
    if (!result.ok) return result;
    const envelope = object(result.value.payload);
    if (
      envelope?.status !== "completed" ||
      envelope.error != null ||
      envelope.incomplete_details != null
    ) return failure("invalid_output");
    const text = openAiText(result.value.payload);
    if (text === undefined) return failure("invalid_output");
    try {
      return success(effectiveOpenAiModel(result.value.payload, options.analysisModel), parse(text));
    } catch {
      return failure("invalid_output");
    }
  };
  return {
    ocr: (input) => analyze(input, `${OCR_PROMPT}\nCanvas: ${input.canvas.width} x ${input.canvas.height}.`, (text) => parseValidatedOcrText(text, input.canvas)),
    scene: (input) => analyze(input, input.prompt, (text) => parseQwenSceneContent(text, input.canvas)),
    completion: async (input) => {
      let prepared: PreparedCompletion;
      try { prepared = await prepareCompletion(input); } catch { return failure("invalid_input"); }
      const form = new FormData();
      form.set("model", options.imageModel);
      form.set("prompt", paddedCompletionPrompt(input.prompt, prepared));
      form.set("image", new Blob([new Uint8Array(prepared.image)], { type: "image/png" }), "input.png");
      form.set("mask", new Blob([new Uint8Array(prepared.hiddenMask)], { type: "image/png" }), "mask.png");
      form.set("size", `${prepared.canvas.width}x${prepared.canvas.height}`);
      const result = await requestWithRetries(fetcher, OPENAI_IMAGE_EDITS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
      }, {
        requestTimeoutMs: options.requestTimeoutMs,
        maxAttempts: options.maxAttempts,
        policy: containsOpenAiPolicyRefusal,
        ...(options.onTransportAttempt === undefined
          ? {}
          : { onTransportAttempt: options.onTransportAttempt }),
      });
      if (!result.ok) return result;
      const root = object(result.value.payload);
      const data = root?.data;
      const encoded = Array.isArray(data) && data.length === 1
        ? object(data[0])?.b64_json
        : undefined;
      if (typeof encoded !== "string") return failure("invalid_output");
      try {
        if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 4) throw new Error("Image payload too large");
        const image = await normalizeGeneratedImage(Buffer.from(encoded, "base64"), "image/png", prepared);
        return success(effectiveOpenAiModel(result.value.payload, options.imageModel), {
          image,
          modelId: effectiveOpenAiModel(result.value.payload, options.imageModel),
          taskId: createHash("sha256").update(encoded).digest("hex"),
          sanitizedMetadata: { status: "succeeded" },
        });
      } catch {
        return failure("invalid_output");
      }
    },
  };
}

function geminiUrl(model: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(model)) throw new Error("Invalid Gemini model identifier");
  return `${GEMINI_API_ORIGIN}/v1/models/${model}:generateContent`;
}

function geminiParts(payload: unknown): Record<string, unknown>[] {
  const candidates = object(payload)?.candidates;
  if (!Array.isArray(candidates)) return [];
  const parts = object(object(candidates[0])?.content)?.parts;
  return Array.isArray(parts)
    ? parts.map(object).filter((part): part is Record<string, unknown> => part !== undefined)
    : [];
}

function geminiFinishReasonIs(payload: unknown, allowed: ReadonlySet<string>): boolean {
  const candidates = object(payload)?.candidates;
  const finishReason = Array.isArray(candidates)
    ? object(candidates[0])?.finishReason
    : undefined;
  return typeof finishReason === "string" && allowed.has(finishReason);
}

function effectiveGeminiModel(payload: unknown, configured: string): string {
  const model = object(payload)?.modelVersion;
  return typeof model === "string" && model.length > 0 ? model : configured;
}

export function createGeminiExecutors(options: ApiAdapterOptions): ProviderOperationExecutors {
  const fetcher = options.fetch ?? fetch;
  const request = async (model: string, body: unknown): Promise<ProviderExecution<unknown>> => {
    let url: string;
    try { url = geminiUrl(model); } catch { return failure("invalid_input"); }
    const result = await requestWithRetries(fetcher, url, {
      method: "POST",
      headers: { "x-goog-api-key": options.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      requestTimeoutMs: options.requestTimeoutMs,
      maxAttempts: options.maxAttempts,
      policy: containsGeminiPolicyRefusal,
      ...(options.onTransportAttempt === undefined
        ? {}
        : { onTransportAttempt: options.onTransportAttempt }),
    });
    if (!result.ok) return result;
    return result.value.payload === undefined ? failure("invalid_output") : success("gemini-http", result.value.payload);
  };
  const analyze = async <T>(input: AnalysisAdapterInput, prompt: string, parse: (text: string) => T): Promise<ProviderExecution<T>> => {
    const response = await request(options.analysisModel, {
      contents: [{ role: "user", parts: [
        { text: prompt },
        { inline_data: { mime_type: "image/png", data: input.image.toString("base64") } },
      ] }],
      generationConfig: { responseMimeType: "application/json" },
    });
    if (!response.ok) return response;
    if (!geminiFinishReasonIs(response.value, GEMINI_ANALYSIS_SUCCESS_FINISH_REASONS)) {
      return failure("invalid_output");
    }
    const textParts = geminiParts(response.value).flatMap((part) =>
      part.thought !== true && typeof part.text === "string" ? [part.text] : []
    );
    if (textParts.length === 0) return failure("invalid_output");
    const text = textParts.join("");
    try {
      return success(effectiveGeminiModel(response.value, options.analysisModel), parse(text));
    } catch {
      return failure("invalid_output");
    }
  };
  return {
    ocr: (input) => analyze(input, `${OCR_PROMPT}\nCanvas: ${input.canvas.width} x ${input.canvas.height}.`, (text) => parseValidatedOcrText(text, input.canvas)),
    scene: (input) => analyze(input, input.prompt, (text) => parseQwenSceneContent(text, input.canvas)),
    completion: async (input) => {
      let prepared: PreparedCompletion;
      try { prepared = await prepareCompletion(input); } catch { return failure("invalid_input"); }
      const response = await request(options.imageModel, {
        contents: [{ role: "user", parts: [
          { text: paddedCompletionPrompt(input.prompt, prepared) },
          { inline_data: { mime_type: "image/png", data: prepared.image.toString("base64") } },
          { inline_data: { mime_type: "image/png", data: prepared.hiddenMask.toString("base64") } },
          { inline_data: { mime_type: "image/png", data: prepared.protectedMask.toString("base64") } },
        ] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      });
      if (!response.ok) return response;
      const candidates = object(response.value)?.candidates;
      if (!Array.isArray(candidates) || candidates.length !== 1) {
        return failure("invalid_output");
      }
      if (!geminiFinishReasonIs(response.value, GEMINI_COMPLETION_SUCCESS_FINISH_REASONS)) {
        return failure("invalid_output");
      }
      const imageParts = geminiParts(response.value).filter((part) => {
        if (part.thought === true) return false;
        return object(part.inlineData) !== undefined || object(part.inline_data) !== undefined;
      });
      if (imageParts.length !== 1) return failure("invalid_output");
      const imagePart = imageParts[0];
      const inline = object(imagePart?.inlineData) ?? object(imagePart?.inline_data);
      const encoded = inline?.data;
      if (typeof encoded !== "string") return failure("invalid_output");
      try {
        if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES * 4 / 3) + 4) throw new Error("Image payload too large");
        const mimeType = inline?.mimeType ?? inline?.mime_type;
        if (typeof mimeType !== "string") throw new Error("Image MIME missing");
        const image = await normalizeGeneratedImage(Buffer.from(encoded, "base64"), mimeType, prepared);
        const model = effectiveGeminiModel(response.value, options.imageModel);
        const finishReason = object(candidates[0])?.finishReason;
        return success(model, {
          image,
          modelId: model,
          taskId: createHash("sha256").update(encoded).digest("hex"),
          sanitizedMetadata: {
            finishReason:
              typeof finishReason === "string" ? finishReason : "STOP",
          },
        });
      } catch {
        return failure("invalid_output");
      }
    },
  };
}

function createHostProviderExecutors(
  bridge: FileHostBridge,
  provider: HostProvider,
): ProviderOperationExecutors {
  const invoke = async <T>(
    request: Parameters<FileHostBridge["invoke"]>[1],
    parse: (result: Extract<Awaited<ReturnType<FileHostBridge["invoke"]>>, { ok: true }>) => Promise<T> | T,
  ): Promise<ProviderExecution<T>> => {
    const result = await bridge.invoke(provider, request);
    if (!result.ok) return result;
    try {
      return validatedHostResult(result, await parse(result));
    } catch {
      return failure("invalid_output");
    }
  };
  const capabilities = bridge.capabilities[provider];
  return {
    ...(capabilities.ocr ? { ocr: (input: AnalysisAdapterInput) => invoke({ operation: "ocr", prompt: `${OCR_PROMPT}\nCanvas: ${input.canvas.width} x ${input.canvas.height}.`, image: input.image, canvas: input.canvas }, (result) => {
      if (result.output.kind !== "text") throw new Error("Expected host OCR text");
      return parseValidatedOcrText(result.output.text, input.canvas);
    }) } : {}),
    ...(capabilities.scene ? { scene: (input: AnalysisAdapterInput & { prompt: string }) => invoke({ operation: "scene", prompt: input.prompt, image: input.image, canvas: input.canvas }, (result) => {
      if (result.output.kind !== "text") throw new Error("Expected host scene text");
      return parseQwenSceneContent(result.output.text, input.canvas);
    }) } : {}),
    ...(capabilities.completion ? { completion: (input: CompletionAdapterInput) => invoke({ operation: "completion", prompt: input.prompt, image: input.image, canvas: input.canvas, hiddenMask: input.hiddenMask, protectedMask: input.protectedMask }, async (result) => {
      if (result.output.kind !== "image") throw new Error("Expected host completion image");
      const metadata = await sharp(result.output.image, { animated: true }).metadata();
      if (
        (metadata.format !== "png" && metadata.format !== "jpeg") ||
        (metadata.pages ?? 1) !== 1
      ) {
        throw new Error("Host completion must be a single-frame PNG or JPEG");
      }
      if (metadata.width !== input.canvas.width || metadata.height !== input.canvas.height) {
        throw new Error("Host completion geometry mismatch");
      }
      const image = await sharp(result.output.image).png().toBuffer();
      return {
        image,
        modelId: result.model,
        taskId: createHash("sha256").update(image).digest("hex"),
        sanitizedMetadata: { channel: "host" },
      };
    }) } : {}),
  };
}

export function createHostExecutors(bridge: FileHostBridge): Readonly<Record<HostProvider, ProviderOperationExecutors>> {
  return {
    openai: createHostProviderExecutors(bridge, "openai"),
    gemini: createHostProviderExecutors(bridge, "gemini"),
  };
}

function classifyAlibaba(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  if (error instanceof APIConnectionError) {
    return new ProviderFailure("retryable_exhausted");
  }
  const sdkCode = error instanceof APIError
    ? error.code
    : object(error)?.code;
  if (
    typeof sdkCode === "string" &&
    sdkCode.replace(/[_-]/g, "").toLowerCase() === "modelnotfound"
  ) {
    return new ProviderFailure("unavailable");
  }
  if (error instanceof APIError && typeof error.status === "number") {
    const classification = classifyHttp(error.status);
    return new ProviderFailure(
      classification === "retry" ? "retryable_exhausted" : classification,
    );
  }
  const status = object(error)?.status;
  if (typeof status === "number" && Number.isInteger(status)) {
    const classification = classifyHttp(status);
    return new ProviderFailure(
      classification === "retry" ? "retryable_exhausted" : classification,
    );
  }
  const message = error instanceof Error ? error.message : "";
  if (/(?:^|status\s+)(?:401|403)\b/i.test(message)) return new ProviderFailure("auth_unavailable");
  if (/(?:^|status\s+)404\b|model.*not found/i.test(message)) return new ProviderFailure("unavailable");
  if (/(?:^|status\s+)(?:408|409|429|5\d\d)\b|timed out|timeout|fetch failed|poll failed/i.test(message)) {
    return new ProviderFailure("retryable_exhausted");
  }
  return new ProviderFailure("invalid_output");
}

export function createAlibabaExecutors(
  config: AppConfig,
  observers: Readonly<{
    ocr?: ProviderResponseObserver;
    scene?: ProviderResponseObserver;
  }> = {},
  onTransportAttempt?: () => void,
): ProviderOperationExecutors {
  const localObserverCall = <T extends unknown[]>(
    callback: ((...args: T) => Promise<void>) | undefined,
  ) => async (...args: T): Promise<void> => {
    if (callback === undefined) return;
    try {
      await callback(...args);
    } catch (cause) {
      throw new ProviderFailure("local_failure", "local_failure", { cause });
    }
  };
  const withAttempt = (observer?: ProviderResponseObserver): ProviderResponseObserver | undefined =>
    observer === undefined && onTransportAttempt === undefined
      ? undefined
      : {
          recordRawResponse: localObserverCall(observer?.recordRawResponse),
          recordRawHttpResponse: localObserverCall(observer?.recordRawHttpResponse),
          recordParseError: localObserverCall(observer?.recordParseError),
          ...(onTransportAttempt === undefined
            ? {}
            : { recordTransportAttempt: onTransportAttempt }),
        };
  const completion = createWanxOcclusionCompletionProvider(
    config,
    undefined,
    onTransportAttempt,
  );
  return {
    ocr: async (input) => {
      try { return success(config.ocrModel, validateOcr(await recognizeText(input.image, config, withAttempt(observers.ocr)), input.canvas)); }
      catch (error) { return { ok: false, failure: classifyAlibaba(error) }; }
    },
    scene: async (input) => {
      try { return success(config.visionModel, await requestSceneGraph(input.image, input.canvas, input.prompt, config, withAttempt(observers.scene))); }
      catch (error) { return { ok: false, failure: classifyAlibaba(error) }; }
    },
    completion: async (input) => {
      try {
        const value = await completion.complete({
          crop: input.image,
          hiddenMask: input.hiddenMask,
          protectedVisibleMask: input.protectedMask,
          semanticContext: [input.prompt],
        });
        const metadata = await sharp(value.image).metadata();
        if (metadata.width !== input.canvas.width || metadata.height !== input.canvas.height) {
          throw new Error("Alibaba completion geometry mismatch");
        }
        return success(value.modelId, { ...value, image: await sharp(value.image).png().toBuffer() });
      } catch (error) {
        return { ok: false, failure: classifyAlibaba(error) };
      }
    },
  };
}
