import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileHostBridge,
  type FileHostBridge,
  type HostBridgeResponse,
} from "../src/providers/host-bridge.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function fixture(
  providers: Record<string, { callable: boolean; operations: string[] }> = {
    openai: { callable: true, operations: ["ocr", "scene", "completion"] },
  },
  options: Parameters<typeof createFileHostBridge>[1] = {},
): Promise<{ root: string; bridge: FileHostBridge; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "host-bridge-test-"));
  await chmod(root, 0o700);
  await writeFile(
    join(root, "capabilities.json"),
    JSON.stringify({ version: 1, providers }),
    { mode: 0o600 },
  );
  const bridge = await createFileHostBridge(root, {
    timeoutMs: 500,
    pollIntervalMs: 5,
    ...options,
  });
  return { root, bridge, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function waitForRequest(root: string): Promise<string> {
  const requestsRoot = join(root, "requests");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const entries = await readdir(requestsRoot);
      if (entries.length === 1) {
        const directory = join(requestsRoot, entries[0]!);
        const requestMetadata = await lstat(join(directory, "request.json"));
        if (requestMetadata.isFile() && !requestMetadata.isSymbolicLink()) {
          return directory;
        }
      }
    } catch {
      // The bridge creates the request directory and files asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("request directory was not created");
}

async function respondAtomically(
  requestDirectory: string,
  response: HostBridgeResponse | string,
): Promise<void> {
  const temporary = join(requestDirectory, "response.json.tmp");
  await writeFile(
    temporary,
    typeof response === "string" ? response : JSON.stringify(response),
    { mode: 0o600 },
  );
  await rename(temporary, join(requestDirectory, "response.json"));
}

async function begin(
  bridge: FileHostBridge,
  root: string,
  operation: "ocr" | "scene" | "completion" = "ocr",
) {
  const resultPromise = bridge.invoke("openai", {
    operation,
    prompt: "Read this slide",
    image: PNG,
    canvas: { width: 1280, height: 720 },
    ...(operation === "completion"
      ? { hiddenMask: PNG, protectedMask: PNG }
      : {}),
  });
  const requestDirectory = await waitForRequest(root);
  const request = JSON.parse(
    await readFile(join(requestDirectory, "request.json"), "utf8"),
  ) as { requestId: string };
  return { resultPromise, requestDirectory, requestId: request.requestId };
}

test("hands a private request to the host and accepts atomic raw text success", async () => {
  const context = await fixture();
  try {
    const pending = await begin(context.bridge, context.root, "completion");
    const request = JSON.parse(
      await readFile(join(pending.requestDirectory, "request.json"), "utf8"),
    );
    assert.deepEqual(request, {
      version: 1,
      requestId: pending.requestId,
      provider: "openai",
      operation: "completion",
      prompt: "Read this slide",
      canvas: { width: 1280, height: 720 },
      imageFile: "input.png",
      hiddenMaskFile: "hidden-mask.png",
      protectedMaskFile: "protected-mask.png",
    });
    assert.deepEqual(await readFile(join(pending.requestDirectory, "input.png")), PNG);
    assert.equal((await lstat(pending.requestDirectory)).mode & 0o077, 0);

    await respondAtomically(pending.requestDirectory, {
      version: 1,
      requestId: pending.requestId,
      status: "success",
      model: "gpt-4.1",
      text: "validated host text",
    });
    assert.deepEqual(await pending.resultPromise, {
      ok: true,
      model: "gpt-4.1",
      output: { kind: "text", text: "validated host text" },
    });
  } finally {
    await context.cleanup();
  }
});

test("returns unavailable immediately when capability is not explicitly callable", async () => {
  const context = await fixture({
    openai: { callable: false, operations: ["ocr"] },
    gemini: { callable: true, operations: ["scene"] },
  });
  try {
    const result = await context.bridge.invoke("openai", {
      operation: "ocr",
      prompt: "ocr",
      image: PNG,
      canvas: { width: 1280, height: 720 },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.status, "unavailable");
      assert.equal(result.failure.reason, "capability_unavailable");
    }
    await assert.rejects(readdir(join(context.root, "requests")), /ENOENT/);
  } finally {
    await context.cleanup();
  }
});

test("uses a bounded wait and classifies host timeout as retryable exhaustion", async () => {
  const context = await fixture(undefined, { timeoutMs: 20, pollIntervalMs: 2 });
  try {
    const result = await context.bridge.invoke("openai", {
      operation: "ocr",
      prompt: "ocr",
      image: PNG,
      canvas: { width: 1280, height: 720 },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.status, "retryable_exhausted");
      assert.equal(result.failure.reason, "bridge_timeout");
    }
  } finally {
    await context.cleanup();
  }
});

test("rejects malformed, mismatched, symlinked, nonregular, and oversized responses", async (t) => {
  const cases: Array<{
    name: string;
    options?: Parameters<typeof createFileHostBridge>[1];
    write(directory: string, requestId: string): Promise<void>;
  }> = [
    {
      name: "malformed JSON",
      write: (directory) => respondAtomically(directory, "{not-json"),
    },
    {
      name: "mismatched request ID",
      write: (directory) =>
        respondAtomically(directory, {
          version: 1,
          requestId: "00000000-0000-4000-8000-000000000000",
          status: "success",
          model: "gpt-4.1",
          text: "text",
        }),
    },
    {
      name: "symlink",
      async write(directory, requestId) {
        const target = join(directory, "elsewhere.json");
        await writeFile(
          target,
          JSON.stringify({
            version: 1,
            requestId,
            status: "success",
            model: "gpt-4.1",
            text: "text",
          }),
        );
        await symlink(target, join(directory, "response.json"));
      },
    },
    {
      name: "nonregular directory",
      write: (directory) => mkdir(join(directory, "response.json")),
    },
    {
      name: "oversized",
      options: { maxResponseBytes: 32 },
      write: (directory) => respondAtomically(directory, "x".repeat(64)),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const context = await fixture(undefined, entry.options);
      try {
        const pending = await begin(context.bridge, context.root);
        await entry.write(pending.requestDirectory, pending.requestId);
        const result = await pending.resultPromise;
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.failure.status, "invalid_output");
      } finally {
        await context.cleanup();
      }
    });
  }
});

test("imports one bounded absolute local image without fetching a URL", async (t) => {
  await t.test("success", async () => {
    const context = await fixture(undefined, { maxArtifactBytes: 32 });
    try {
      const imagePath = join(context.root, "host-result.png");
      await writeFile(imagePath, Buffer.concat([PNG, Buffer.from([1, 2, 3])]));
      const pending = await begin(context.bridge, context.root, "completion");
      await respondAtomically(pending.requestDirectory, {
        version: 1,
        requestId: pending.requestId,
        status: "success",
        model: "gpt-image-2",
        imagePath,
      });
      assert.deepEqual(await pending.resultPromise, {
        ok: true,
        model: "gpt-image-2",
        output: {
          kind: "image",
          image: Buffer.concat([PNG, Buffer.from([1, 2, 3])]),
        },
      });
    } finally {
      await context.cleanup();
    }
  });

  for (const entry of ["http-url", "symlink", "directory", "oversized"] as const) {
    await t.test(`rejects ${entry}`, async () => {
      const context = await fixture(undefined, { maxArtifactBytes: 16 });
      try {
        const realPath = join(context.root, "real-image.png");
        await writeFile(realPath, Buffer.alloc(entry === "oversized" ? 17 : 8));
        let imagePath = realPath;
        if (entry === "http-url") imagePath = "https://example.test/result.png";
        if (entry === "symlink") {
          imagePath = join(context.root, "linked-image.png");
          await symlink(realPath, imagePath);
        }
        if (entry === "directory") {
          imagePath = join(context.root, "image-directory");
          await mkdir(imagePath);
        }

        const pending = await begin(context.bridge, context.root, "completion");
        await respondAtomically(pending.requestDirectory, {
          version: 1,
          requestId: pending.requestId,
          status: "success",
          model: "gpt-image-2",
          imagePath,
        });
        const result = await pending.resultPromise;
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.failure.status, "invalid_output");
      } finally {
        await context.cleanup();
      }
    });
  }
});

test("accepts classified host failure but rejects ambiguous success and unsafe model labels", async (t) => {
  const cases = [
    {
      name: "classified failure",
      response: {
      status: "failure",
      failure: { status: "auth_unavailable", reason: "credentials_unavailable" },
      },
    },
    {
      name: "ambiguous success",
      response: {
        status: "success",
        model: "gpt-4.1",
        text: "text",
        imagePath: "/tmp/image.png",
      },
    },
    {
      name: "unsafe model label",
      response: {
        status: "success",
        model: "gpt-4.1\nsecret",
        text: "text",
      },
    },
  ] as const;
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const context = await fixture();
      try {
        const pending = await begin(context.bridge, context.root);
        await respondAtomically(pending.requestDirectory, {
          version: 1,
          requestId: pending.requestId,
          ...entry.response,
        } as HostBridgeResponse);
        const result = await pending.resultPromise;
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.equal(
            result.failure.status,
            entry.response.status === "failure"
              ? "auth_unavailable"
              : "invalid_output",
          );
        }
      } finally {
        await context.cleanup();
      }
    });
  }
});
