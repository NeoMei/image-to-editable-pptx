import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FileHostBridge, HostBridgeRequest, HostBridgeResult, HostProvider } from "./host-bridge.js";
import {
  containsOpenAiPolicyRefusal,
  openAiText,
} from "./provider-adapters.js";
import { isSafeModelIdentifier, ProviderFailure, type ProviderFailureStatus } from "./routing.js";

type Environment = Readonly<Record<string, string | undefined>>;
type DiscoveryOptions = Readonly<{
  discover?: () => Promise<string>;
  imageRouting?: () => Promise<unknown>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}>;
const execute = promisify(execFile);
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function fail(status: ProviderFailureStatus): HostBridgeResult {
  return { ok: false, failure: new ProviderFailure(status, status) };
}

function httpFailure(status: number): ProviderFailureStatus {
  if (status === 401 || status === 403) return "auth_unavailable";
  if (status === 404) return "unavailable";
  if ([408, 409, 429].includes(status) || status >= 500) return "retryable_exhausted";
  return "invalid_input";
}

function refused(payload: unknown): boolean {
  return containsOpenAiPolicyRefusal(payload) ||
    /^(?:response\.refusal\.(?:delta|done))$/.test(String(object(payload)?.type));
}

async function boundedBytes(response: Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ProviderFailure("invalid_output");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > maximum) throw new ProviderFailure("invalid_output");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new ProviderFailure("invalid_output");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseResponse(text: string, streaming: boolean): Record<string, unknown> {
  if (!streaming) {
    const result = object(JSON.parse(text));
    if (refused(result)) throw new ProviderFailure("policy_refused");
    if (
      result?.status !== "completed" ||
      result.error != null ||
      result.incomplete_details != null
    ) throw new ProviderFailure("invalid_output");
    return result;
  }
  let completed: Record<string, unknown> | undefined;
  const items = new Map<number, unknown>();
  for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    const event = object(JSON.parse(data));
    if (refused(event)) throw new ProviderFailure("policy_refused");
    if (["error", "response.failed"].includes(String(event?.type))) {
      const error = object(event?.error) ?? object(object(event?.response)?.error);
      const code = String(error?.code ?? event?.code);
      const upstreamReset = error?.type === "upstream_error" && error.code === "upstream_reset";
      throw new ProviderFailure(upstreamReset || /rate_limit|server_error|overloaded/.test(code) ? "retryable_exhausted" : "invalid_output");
    }
    if (event?.type === "response.incomplete") throw new ProviderFailure("invalid_output");
    if (event?.type === "response.output_item.done" && Number.isInteger(event.output_index)) items.set(event.output_index as number, event.item);
    if (event?.type === "response.completed") completed = object(event.response);
  }
  if (
    completed?.status !== "completed" ||
    completed.error != null ||
    completed.incomplete_details != null
  ) throw new ProviderFailure("invalid_output");
  if (!Array.isArray(completed.output) || completed.output.length === 0) {
    completed.output = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  }
  return completed;
}

function validatedBase(raw: unknown): URL {
  if (typeof raw !== "string") throw new Error("Missing local endpoint");
  const base = new URL(raw);
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(base.hostname) ||
      base.username || base.password || base.search || base.hash || !/^\/v1\/?$/.test(base.pathname)) {
    throw new Error("OpenCodex endpoint must be a literal loopback /v1 URL");
  }
  base.pathname = "/v1/";
  return base;
}

/** Use only the public local admission API; never read OAuth files or host session tokens. */
export async function discoverOpenCodexBridge(
  env: Environment = process.env,
  options: DiscoveryOptions = {},
): Promise<FileHostBridge | undefined> {
  if (env.IMAGE_PPT_OPENCODEX === "off") return undefined;
  const fetcher = options.fetch ?? fetch;
  let base: URL;
  let catalog: Record<string, unknown>[];
  try {
    const discovered = await (options.discover ?? (async () => {
      const result = await execute("ocx", ["access", "endpoints", "--json"], {
        env: { ...env }, timeout: 45_000, maxBuffer: 1024 * 1024, encoding: "utf8",
      });
      return result.stdout;
    }))();
    base = validatedBase(object(JSON.parse(discovered))?.baseUrl);
    const response = await fetcher(new URL("models", base), { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const rows = object(JSON.parse((await boundedBytes(response, MAX_TEXT_BYTES)).toString("utf8")))?.data;
    if (!Array.isArray(rows)) return undefined;
    catalog = rows.map(object).filter((row): row is Record<string, unknown> => row !== undefined);
  } catch { return undefined; }

  const select = (provider: string, preferred: string): string | undefined => {
    const bare = preferred.startsWith(`${provider}/`) ? preferred.slice(provider.length + 1) : preferred;
    if (!isSafeModelIdentifier(bare) || bare.includes("/")) return undefined;
    const row = catalog.find((entry) => entry.owned_by === provider &&
      (entry.id === bare || entry.id === `${provider}/${bare}`) &&
      object(entry.capabilities)?.supports_vision === true);
    return row === undefined ? undefined : `${provider}/${bare}`;
  };
  const analysis = select("openai", env.OPENCODEX_OPENAI_ANALYSIS_MODEL ?? "gpt-5.6-sol");
  if (!analysis) return undefined;
  const timeout = options.requestTimeoutMs ?? 120_000;
  const headers = { "Content-Type": "application/json" };
  const call = async (model: string, prompt: string, images: Buffer[]) => {
    const response = await fetcher(new URL("responses", base), {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        model, stream: true, store: false,
        instructions: "Follow the supplied image analysis or editing task. Return only the requested result.",
        input: [{ role: "user", content: [
          { type: "input_text", text: prompt },
          ...images.map((image) => ({ type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}` })),
        ] }],
      }),
    });
    const text = (await boundedBytes(response, MAX_TEXT_BYTES)).toString("utf8");
    if (!response.ok) {
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { /* Keep raw upstream errors private. */ }
      throw new ProviderFailure(refused(payload) ? "policy_refused" : httpFailure(response.status));
    }
    const result = parseResponse(text, response.headers.get("content-type")?.includes("text/event-stream") === true);
    const actualModel = typeof result.model === "string" ? result.model : model;
    if (!isSafeModelIdentifier(actualModel)) throw new ProviderFailure("invalid_output");
    const output = openAiText(result);
    if (output === undefined) throw new ProviderFailure("invalid_output");
    return { model: actualModel, text: output };
  };
  return {
    capabilities: {
      openai: { ocr: true, scene: true, completion: false },
    },
    async invoke(provider: HostProvider, request: HostBridgeRequest): Promise<HostBridgeResult> {
      try {
        if (provider !== "openai") return fail("unavailable");
        // Real host completions failed source-locked QA, including a mask probe.
        // Reject before preparing or transmitting any image-edit request.
        if (request.operation === "completion") return fail("unavailable");
        const result = await call(analysis, request.prompt, [request.image]);
        return { ok: true, model: result.model, output: { kind: "text", text: result.text } };
      } catch (error) {
        if (error instanceof ProviderFailure) return { ok: false, failure: error };
        if (error instanceof Error && ["AbortError", "TimeoutError", "TypeError"].includes(error.name)) return fail("retryable_exhausted");
        return fail("invalid_output");
      }
    },
  };
}
