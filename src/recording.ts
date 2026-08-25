import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { z } from "zod";

const SENSITIVE_KEY = /^(?:authorization|apiKey|access_token)$/i;
const DASHSCOPE_HEADER = /^x-dashscope-/i;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

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
            !SENSITIVE_KEY.test(key) && !DASHSCOPE_HEADER.test(key),
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
