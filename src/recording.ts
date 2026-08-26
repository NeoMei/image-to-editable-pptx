import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { z } from "zod";

const SENSITIVE_KEY = /^(?:authorization|apiKey|access_token)$/i;
const PROVIDER_SECRET_HEADER =
  /^(?:x-dashscope-|x-acs-|x-aliyun-|x-alibaba-|x-oss-)/i;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const MAX_PROVIDER_RECORDING_STRING_CHARS = 8_192;
export const MAX_PROVIDER_RECORDING_KEY_CHARS = 256;
export const MAX_PROVIDER_RECORDING_TOTAL_STRING_CHARS = 65_536;
export const MAX_PROVIDER_RECORDING_NODES = 4_096;
export const MAX_PROVIDER_RECORDING_DEPTH = 16;

export type SanitizedProviderRecording = {
  payload: JsonValue;
  sanitization: {
    truncated: boolean;
    truncatedStrings: number;
    truncatedKeys: number;
    truncatedTotalStrings: number;
    truncatedNodes: number;
    truncatedDepth: number;
    recordedStringChars: number;
    visitedNodes: number;
  };
};

const PROVIDER_BEARER = /\bbearer\s+[^\s,;}"']+/gi;
const PROVIDER_CREDENTIAL =
  /\b(?:sk-[a-z0-9_-]{8,}|LTAI[a-z0-9]{12,})\b/gi;
const PROVIDER_SECRET_HEADER_ASSIGNMENT =
  /\b(?:x-dashscope|x-acs|x-aliyun|x-alibaba|x-oss)-[a-z0-9-]+\s*[:=]\s*[^\s,;}"']+/gi;
const SIGNED_QUERY_KEY =
  /(?:signature|accesskey|securitytoken|expires)/i;
const URL_CANDIDATE = /https?:\/\/[^\s<>"']+/gi;

function redactProviderString(value: string, configuredApiKey: string): string {
  let sanitized = value;
  if (configuredApiKey.length > 0) {
    sanitized = sanitized.split(configuredApiKey).join("[REDACTED]");
  }
  sanitized = sanitized
    .replace(PROVIDER_BEARER, "[REDACTED]")
    .replace(PROVIDER_CREDENTIAL, "[REDACTED]");
  sanitized = sanitized.replace(URL_CANDIDATE, (candidate) => {
    try {
      const url = new URL(candidate);
      const signed = [...url.searchParams.keys()].some((key) =>
        SIGNED_QUERY_KEY.test(key.replace(/[-_]/g, "")),
      );
      return signed ? "[REDACTED_URL]" : candidate;
    } catch {
      return candidate;
    }
  });
  return sanitized.replace(PROVIDER_SECRET_HEADER_ASSIGNMENT, "[REDACTED]");
}

export function sanitizeProviderRecording(
  payload: unknown,
  configuredApiKey: string,
): SanitizedProviderRecording {
  const state = {
    truncatedStrings: 0,
    truncatedKeys: 0,
    truncatedTotalStrings: 0,
    truncatedNodes: 0,
    truncatedDepth: 0,
    recordedStringChars: 0,
    visitedNodes: 0,
  };
  const ancestors = new WeakSet<object>();

  const boundString = (
    value: string,
    perStringLimit: number,
    kind: "key" | "value",
  ): string => {
    const remaining = Math.max(
      0,
      MAX_PROVIDER_RECORDING_TOTAL_STRING_CHARS - state.recordedStringChars,
    );
    const length = Math.min(value.length, perStringLimit, remaining);
    if (length < value.length) {
      if (kind === "key") state.truncatedKeys += 1;
      else state.truncatedStrings += 1;
      if (remaining < Math.min(value.length, perStringLimit)) {
        state.truncatedTotalStrings += 1;
      }
    }
    state.recordedStringChars += length;
    return value.slice(0, length);
  };

  const visit = (value: unknown, depth: number): JsonValue => {
    if (state.visitedNodes >= MAX_PROVIDER_RECORDING_NODES) {
      state.truncatedNodes += 1;
      return boundString("[TRUNCATED_NODE_LIMIT]", 22, "value");
    }
    state.visitedNodes += 1;
    if (depth > MAX_PROVIDER_RECORDING_DEPTH) {
      state.truncatedDepth += 1;
      return boundString("[TRUNCATED_DEPTH_LIMIT]", 23, "value");
    }
    if (typeof value === "string") {
      const sanitized = redactProviderString(value, configuredApiKey);
      return boundString(
        sanitized,
        MAX_PROVIDER_RECORDING_STRING_CHARS,
        "value",
      );
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("Provider recording contains a non-finite number");
      }
      return value;
    }
    if (typeof value !== "object") {
      throw new TypeError(
        `Provider recording contains a non-JSON ${typeof value} value`,
      );
    }
    if (ancestors.has(value)) {
      throw new TypeError("Provider recording contains a circular reference");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const items: JsonValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (
            state.recordedStringChars >=
            MAX_PROVIDER_RECORDING_TOTAL_STRING_CHARS
          ) {
            state.truncatedTotalStrings += value.length - index;
            state.truncatedNodes += value.length - index;
            break;
          }
          if (state.visitedNodes >= MAX_PROVIDER_RECORDING_NODES) {
            state.truncatedNodes += value.length - index;
            break;
          }
          items.push(visit(value[index], depth + 1));
        }
        return items;
      }
      const object: Record<string, JsonValue> = {};
      const entries = Object.entries(value);
      for (let index = 0; index < entries.length; index += 1) {
        const [key, nested] = entries[index]!;
        if (
          state.recordedStringChars >=
          MAX_PROVIDER_RECORDING_TOTAL_STRING_CHARS
        ) {
          state.truncatedTotalStrings += entries.length - index;
          state.truncatedNodes += entries.length - index;
          break;
        }
        if (state.visitedNodes >= MAX_PROVIDER_RECORDING_NODES) {
          state.truncatedNodes += entries.length - index;
          break;
        }
        if (SENSITIVE_KEY.test(key) || PROVIDER_SECRET_HEADER.test(key)) continue;
        const redactedKey = redactProviderString(key, configuredApiKey);
        let outputKey = boundString(
          redactedKey === key ? key : `[REDACTED_KEY_${index}]`,
          MAX_PROVIDER_RECORDING_KEY_CHARS,
          "key",
        );
        if (Object.hasOwn(object, outputKey)) {
          outputKey = boundString(
            `[DUPLICATE_KEY_${index}]`,
            MAX_PROVIDER_RECORDING_KEY_CHARS,
            "key",
          );
        }
        Object.defineProperty(object, outputKey, {
          configurable: true,
          enumerable: true,
          value: visit(nested, depth + 1),
          writable: true,
        });
      }
      return object;
    } finally {
      ancestors.delete(value);
    }
  };

  const sanitizedPayload = visit(payload, 0);
  return {
    payload: sanitizedPayload,
    sanitization: {
      truncated:
        state.truncatedStrings > 0 ||
        state.truncatedKeys > 0 ||
        state.truncatedTotalStrings > 0 ||
        state.truncatedNodes > 0 ||
        state.truncatedDepth > 0,
      ...state,
    },
  };
}

function sanitize(value: unknown, ancestors = new WeakSet<object>()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Recording payload contains a non-finite number");
    }

    return value;
  }

  if (typeof value !== "object") {
    throw new TypeError(
      `Recording payload contains a non-JSON ${typeof value} value`,
    );
  }

  if (ancestors.has(value)) {
    throw new TypeError("Recording payload contains a circular reference");
  }

  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const sanitizedItems: JsonValue[] = [];

      for (let index = 0; index < value.length; index += 1) {
        sanitizedItems[index] = sanitize(value[index], ancestors);
      }

      return sanitizedItems;
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !SENSITIVE_KEY.test(key) && !PROVIDER_SECRET_HEADER.test(key),
        )
        .map(([key, nestedValue]) => [
          key,
          sanitize(nestedValue, ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export async function writeRecording(
  path: string,
  payload: unknown,
): Promise<void> {
  const serialized = JSON.stringify(sanitize(payload), null, 2);

  if (serialized === undefined) {
    throw new TypeError("Recording payload must be JSON serializable");
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${serialized}\n`, "utf8");
}

export async function readRecording<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = JSON.parse(await readFile(path, "utf8"));
  return schema.parse(payload);
}
