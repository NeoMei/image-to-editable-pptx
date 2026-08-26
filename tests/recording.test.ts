import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { z } from "zod";

import {
  MAX_PROVIDER_RECORDING_STRING_CHARS,
  MAX_PROVIDER_RECORDING_TOTAL_STRING_CHARS,
  readRecording,
  sanitizeProviderRecording,
  writeRecording,
} from "../src/recording.js";

test("sanitizes and deterministically bounds nested provider values", () => {
  const configuredKey = "configured-provider-key-canary-987654321";
  const signedQueryCanary = "signed-query-canary-must-not-survive";
  const hugeCanary = "huge-tail-canary-must-not-survive";
  const hugeKeyCanary = "huge-key-tail-canary-must-not-survive";
  let deep: unknown = "safe-leaf";
  for (let index = 0; index < 32; index += 1) deep = { nested: deep };
  const recording = sanitizeProviderRecording(
    {
      message: {
        content: configuredKey,
        detail: "Bearer bearer-value-canary-123456789",
        url: `https://bucket.oss-cn-beijing.aliyuncs.com/object.png?X-OSS-Signature=${signedQueryCanary}&Expires=999999#fragment-canary`,
      },
      items: [
        { value: "sk-credential-shaped-canary-123456789" },
        { note: "x-dashscope-api-key: dashscope-header-canary-123456789" },
        { detail: "X-Acs-AccessKey-Id: alibaba-header-canary-123456789" },
        { content: "X-OSS-Security-Token: oss-header-canary-123456789" },
        {
          content:
            "safe-prefix-" +
            "x".repeat(MAX_PROVIDER_RECORDING_STRING_CHARS * 2) +
            hugeCanary,
        },
      ],
      deep,
      wide: Array.from({ length: 100 }, () =>
        "y".repeat(MAX_PROVIDER_RECORDING_STRING_CHARS),
      ),
      [`${configuredKey}-${"k".repeat(1_000)}-${hugeKeyCanary}`]: "safe",
    },
    configuredKey,
  );
  const nodeBounded = sanitizeProviderRecording(
    { many: Array.from({ length: 5_000 }, (_, index) => index) },
    configuredKey,
  );
  const keyBounded = sanitizeProviderRecording(
    {
      [`safe-${"k".repeat(1_000)}-${hugeKeyCanary}`]: "safe",
      [configuredKey]: "safe",
    },
    configuredKey,
  );
  const text = JSON.stringify(recording);
  const allText = text + JSON.stringify(keyBounded);
  const reparsed = JSON.parse(text) as typeof recording;

  assert.deepEqual(reparsed, recording);
  assert.equal(recording.sanitization.truncated, true);
  assert.ok(recording.sanitization.truncatedStrings > 0);
  assert.ok(recording.sanitization.visitedNodes > 0);
  assert.ok(text.length < 100_000);
  assert.ok(nodeBounded.sanitization.truncatedNodes > 0);
  assert.ok(recording.sanitization.truncatedDepth > 0);
  assert.ok(keyBounded.sanitization.truncatedKeys > 0);
  assert.ok(recording.sanitization.truncatedTotalStrings > 0);
  assert.ok(
    recording.sanitization.recordedStringChars <=
      MAX_PROVIDER_RECORDING_TOTAL_STRING_CHARS,
  );
  const nodePayload = nodeBounded.payload as { many: unknown[] };
  assert.ok(nodePayload.many.length <= 4_096);
  assert.doesNotMatch(
    allText,
    /configured-provider-key-canary|bearer-value-canary|signed-query-canary|fragment-canary|credential-shaped-canary|dashscope-header-canary|alibaba-header-canary|oss-header-canary|huge-tail-canary|huge-key-tail-canary|X-OSS-Signature|Expires=999999/i,
  );
  assert.match(text, /REDACTED/);
});

test("removes nested credentials and DashScope headers before recording", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-recording-"));
  const recordingPath = join(directory, "nested", "response.json");

  try {
    await writeRecording(recordingPath, {
      authorization: "Bearer top-level-secret",
      safe: "kept",
      nested: {
        apiKey: "nested-secret",
        access_token: "token-secret",
        headers: {
          "Content-Type": "application/json",
          "X-DashScope-WorkSpace": "workspace-secret",
        },
      },
      items: [
        {
          Authorization: "Bearer array-secret",
          "x-dashscope-api-key": "header-secret",
          value: 42,
        },
      ],
    });

    const text = await readFile(recordingPath, "utf8");
    assert.ok(text.endsWith("\n"));
    assert.deepEqual(JSON.parse(text), {
      safe: "kept",
      nested: { headers: { "Content-Type": "application/json" } },
      items: [{ value: 42 }],
    });
    assert.doesNotMatch(text, /secret/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("redacts normalized sensitive-key aliases in nested objects and arrays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-recording-aliases-"));
  const recordingPath = join(directory, "response.json");
  const canaries = [
    "opaque-api-underscore-canary-6419",
    "opaque-access-camel-canary-7528",
    "opaque-secret-case-canary-8637",
    "opaque-api-hyphen-canary-9746",
    "opaque-access-hyphen-canary-1855",
    "opaque-client-secret-canary-2964",
  ];

  try {
    const sanitized = sanitizeProviderRecording(
      {
        nested: {
          api_key: canaries[0],
          accessToken: canaries[1],
          Secret: canaries[2],
        },
        items: [
          { "API-KEY": canaries[3] },
          { "access-token": canaries[4] },
          { client_secret: canaries[5] },
        ],
        harmless: {
          tokenCount: 12,
          apiKeyStatus: "kept",
          secretSauce: "kept",
          monkey: "kept",
        },
      },
      "unrelated-configured-key",
    );
    assert.deepEqual(sanitized.payload, {
      nested: {
        api_key: "[REDACTED]",
        accessToken: "[REDACTED]",
        Secret: "[REDACTED]",
      },
      items: [
        { "API-KEY": "[REDACTED]" },
        { "access-token": "[REDACTED]" },
        { client_secret: "[REDACTED]" },
      ],
      harmless: {
        tokenCount: 12,
        apiKeyStatus: "kept",
        secretSauce: "kept",
        monkey: "kept",
      },
    });
    await writeRecording(recordingPath, sanitized);

    const text = await readFile(recordingPath, "utf8");
    const persisted = JSON.parse(text) as {
      payload: Record<string, unknown>;
    };
    assert.doesNotMatch(text, new RegExp(canaries.join("|"), "i"));
    assert.deepEqual(persisted.payload, {
      nested: {},
      items: [{}, {}, {}],
      harmless: {
        tokenCount: 12,
        apiKeyStatus: "kept",
        secretSauce: "kept",
        monkey: "kept",
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("round-trips a sanitized fixture through a supplied Zod schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-recording-"));
  const recordingPath = join(directory, "fixture.json");
  const schema = z.object({
    requestId: z.string(),
    output: z.object({ text: z.string() }),
  });

  try {
    await writeRecording(recordingPath, {
      requestId: "request-123",
      output: { text: "hello" },
      apiKey: "must-not-be-recorded",
    });

    const parsed = await readRecording(recordingPath, schema);

    assert.deepEqual(parsed, {
      requestId: "request-123",
      output: { text: "hello" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an enumerable toJSON function before it can reintroduce secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-recording-"));
  const recordingPath = join(directory, "fixture.json");
  let toJsonCalled = false;

  try {
    await assert.rejects(
      writeRecording(recordingPath, {
        safe: "kept",
        toJSON() {
          toJsonCalled = true;
          return {
            authorization: "Bearer reintroduced-secret",
            apiKey: "reintroduced-secret",
          };
        },
      }),
      /function/i,
    );
    assert.equal(toJsonCalled, false);
    await assert.rejects(readFile(recordingPath, "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not invoke own or inherited array map overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-recording-"));
  const recordingPath = join(directory, "fixture.json");
  const ownOverride = [{ value: "own-safe" }];
  const inheritedOverride = [{ value: "inherited-safe" }];
  let ownMapCalled = false;
  let inheritedMapCalled = false;

  Object.defineProperty(ownOverride, "map", {
    enumerable: true,
    value() {
      ownMapCalled = true;
      return [{ authorization: "Bearer own-secret" }];
    },
  });
  Object.setPrototypeOf(inheritedOverride, {
    map() {
      inheritedMapCalled = true;
      return [{ apiKey: "inherited-secret" }];
    },
  });

  try {
    await writeRecording(recordingPath, {
      ownOverride,
      inheritedOverride,
    });

    const text = await readFile(recordingPath, "utf8");
    assert.equal(ownMapCalled, false);
    assert.equal(inheritedMapCalled, false);
    assert.doesNotMatch(text, /secret/);
    assert.deepEqual(JSON.parse(text), {
      ownOverride: [{ value: "own-safe" }],
      inheritedOverride: [{ value: "inherited-safe" }],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
