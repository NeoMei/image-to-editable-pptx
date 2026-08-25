import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { z } from "zod";

import { readRecording, writeRecording } from "../src/recording.js";

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
