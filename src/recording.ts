import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { z } from "zod";

const SENSITIVE_KEY_ALIASES = new Set([
  "authorization",
  "apikey",
  "apisecret",
  "accesstoken",
  "accesskey",
  "accesskeyid",
  "accesskeysecret",
  "secretaccesskey",
  "clientsecret",
  "credential",
  "password",
  "privatekey",
  "secret",
]);
const PROVIDER_SECRET_HEADER =
  /^(?:x-dashscope-|x-acs-|x-aliyun-|x-alibaba-|x-oss-)/i;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s._-]+/g, "");
  return SENSITIVE_KEY_ALIASES.has(normalized);
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const OPAQUE_METADATA_KEY = /^(?:(?:provider|task|request|job|trace|session|operation|execution|run|correlation|event|opaque)(?:id|key|token|uuid|reference)|(?:id|uuid|token))$/;
const OPAQUE_METADATA_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPAQUE_METADATA_VALUE = /^[a-z0-9][a-z0-9._~+/=-]{15,}$/i;

function isOpaqueMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s._-]+/g, "");
  return OPAQUE_METADATA_KEY.test(normalized);
}

function isOpaqueMetadataString(value: string): boolean {
  if (
    value.includes("[REDACTED") ||
    /^https?:\/\//i.test(value) ||
    OPAQUE_METADATA_UUID.test(value)
  ) {
    return true;
  }
  return (
    OPAQUE_METADATA_VALUE.test(value) &&
    /[a-z]/i.test(value) &&
    /\d/.test(value)
  );
}

function pruneOpaqueProviderMetadata(value: JsonValue): JsonValue | undefined {
  if (typeof value === "string") {
    return isOpaqueMetadataString(value) ? undefined : value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = pruneOpaqueProviderMetadata(item);
      return sanitized === undefined ? [] : [sanitized];
    });
  }
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key) || PROVIDER_SECRET_HEADER.test(key) || isOpaqueMetadataKey(key)) {
      continue;
    }
    const pruned = pruneOpaqueProviderMetadata(nested);
    if (pruned !== undefined) sanitized[key] = pruned;
  }
  return sanitized;
}

export function sanitizeProviderMetadata(payload: unknown): JsonValue {
  const bounded = sanitizeProviderRecording(payload, "").payload;
  return pruneOpaqueProviderMetadata(bounded) ?? null;
}

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
const QUOTED_CREDENTIAL_VALUE_ASSIGNMENT =
  /(["'])([^"'\\\r\n]{1,64})\1\s*[:=]\s*(["'])([^"'\\\r\n]{0,8192})\3/gi;
const QUOTED_CREDENTIAL_ASSIGNMENT =
  /(["'])([^"'\\\r\n]{1,64})\1\s*[:=]\s*(["']?)(?:bearer\s+)?[^\s,;}"']+\3/gi;
const BARE_CREDENTIAL_ASSIGNMENT =
  /\b([a-z][a-z0-9._-]{0,63})\s*[:=]\s*(["']?)(?:bearer\s+)?[^\s,;}"']+\2/gi;
const SIGNED_QUERY_KEY =
  /(?:signature|accesskey|securitytoken|expires)/i;
const URL_CANDIDATE = /https?:\/\/[^\s<>"']+/gi;

export function redactProviderText(
  value: string,
  configuredApiKey: string,
): string {
  let sanitized = value;
  if (configuredApiKey.length > 0) {
    sanitized = sanitized.split(configuredApiKey).join("[REDACTED]");
  }
  sanitized = sanitized
    .replace(PROVIDER_BEARER, "[REDACTED]")
    .replace(PROVIDER_CREDENTIAL, "[REDACTED]");
  const redactAssignment = (match: string, key: string): string =>
    isSensitiveKey(key) || PROVIDER_SECRET_HEADER.test(key)
      ? "[REDACTED]"
      : match;
  sanitized = sanitized
    .replace(
      QUOTED_CREDENTIAL_VALUE_ASSIGNMENT,
      (match, _keyQuote: string, key: string) =>
        redactAssignment(match, key),
    )
    .replace(
      QUOTED_CREDENTIAL_ASSIGNMENT,
      (match, _quote: string, key: string) => redactAssignment(match, key),
    )
    .replace(
      BARE_CREDENTIAL_ASSIGNMENT,
      (match, key: string) => redactAssignment(match, key),
    );
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
      const sanitized = redactProviderText(value, configuredApiKey);
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
        if (PROVIDER_SECRET_HEADER.test(key)) continue;
        if (isSensitiveKey(key)) {
          const outputKey = boundString(
            key,
            MAX_PROVIDER_RECORDING_KEY_CHARS,
            "key",
          );
          Object.defineProperty(object, outputKey, {
            configurable: true,
            enumerable: true,
            value: boundString("[REDACTED]", 10, "value"),
            writable: true,
          });
          continue;
        }
        const redactedKey = redactProviderText(key, configuredApiKey);
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

function sanitize(
  value: unknown,
  ancestors = new WeakSet<object>(),
  redactStrings = false,
): JsonValue {
  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return redactStrings ? redactProviderText(value, "") : value;
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
        sanitizedItems[index] = sanitize(
          value[index],
          ancestors,
          redactStrings,
        );
      }

      return sanitizedItems;
    }

    const sanitizedObject: Record<string, JsonValue> = {};
    for (const [index, [key, nestedValue]] of Object.entries(value).entries()) {
      if (PROVIDER_SECRET_HEADER.test(key) || isSensitiveKey(key)) continue;
      const redactedKey = redactProviderText(key, "");
      let outputKey = redactedKey === key ? key : `[REDACTED_KEY_${index}]`;
      if (Object.hasOwn(sanitizedObject, outputKey)) {
        outputKey = `[DUPLICATE_KEY_${index}]`;
      }
      Object.defineProperty(sanitizedObject, outputKey, {
        configurable: true,
        enumerable: true,
        value: sanitize(nestedValue, ancestors, redactStrings),
        writable: true,
      });
    }
    return sanitizedObject;
  } finally {
    ancestors.delete(value);
  }
}

export function sanitizeRecordingPayload(payload: unknown): JsonValue {
  return sanitize(payload, new WeakSet<object>(), true);
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
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`ELOOP: Recording target must be a regular file: ${path}`);
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${randomUUID()}`,
  );
  try {
    const file = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.chmod(0o600);
      await file.writeFile(`${serialized}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function writeProviderMetadataRecording(
  path: string,
  payload: unknown,
): Promise<void> {
  await writeRecording(path, sanitizeRecordingPayload(payload));
}

export async function readRecording<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = JSON.parse(await readFile(path, "utf8"));
  return schema.parse(payload);
}
