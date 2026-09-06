import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { readAnalysisPackage } from "../src/analysis/package.js";

type BridgeRequest = Readonly<{
  version: 1;
  requestId: string;
  provider: "openai";
  operation: "ocr" | "scene" | "completion";
  canvas: { width: number; height: number };
  imageFile: string;
}>;

type ChildResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

function credentialFreeEnvironment(preloadPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `--import=${preloadPath}`,
  };
  for (const name of [
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_WORKSPACE_ID",
    "OPENAI_API_KEY",
  ]) {
    delete env[name];
  }
  return env;
}

function capture(child: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolveChild, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveChild({ code, stdout, stderr }));
  });
}

function launchCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { child: ChildProcessWithoutNullStreams; result: Promise<ChildResult> } {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("src/cli.ts"), ...args],
    { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end();
  return { child, result: capture(child) };
}

async function publishResponse(
  requestDirectory: string,
  response: unknown,
): Promise<void> {
  const temporary = join(requestDirectory, ".response.json.tmp");
  await writeFile(temporary, JSON.stringify(response), { mode: 0o600 });
  await rename(temporary, join(requestDirectory, "response.json"));
}

async function serviceBridgeUntilExit(
  bridgeDirectory: string,
  childResult: Promise<ChildResult>,
): Promise<{ result: ChildResult; requests: BridgeRequest[] }> {
  const servedIds = new Set<string>();
  const requests: BridgeRequest[] = [];
  let settled: ChildResult | undefined;
  void childResult.then((result) => {
    settled = result;
  });

  const deadline = Date.now() + 30_000;
  while (settled === undefined && Date.now() < deadline) {
    let entries: string[] = [];
    try {
      entries = await readdir(join(bridgeDirectory, "requests"));
    } catch {
      // The CLI creates the request root on its first host operation.
    }
    for (const entry of entries.sort()) {
      const requestDirectory = join(bridgeDirectory, "requests", entry);
      let request: BridgeRequest;
      try {
        request = JSON.parse(
          await readFile(join(requestDirectory, "request.json"), "utf8"),
        ) as BridgeRequest;
      } catch {
        continue;
      }
      if (servedIds.has(request.requestId)) continue;
      servedIds.add(request.requestId);
      requests.push(request);

      assert.equal(request.version, 1);
      assert.match(request.requestId, /^[0-9a-f-]{36}$/i);
      assert.equal(request.provider, "openai");
      assert.deepEqual(request.canvas, { width: 320, height: 180 });
      assert.equal(request.imageFile, "input.png");
      assert.deepEqual(
        (await readFile(join(requestDirectory, request.imageFile))).subarray(0, 8),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      const text = request.operation === "ocr"
        ? JSON.stringify({ lines: [] })
        : request.operation === "scene"
          ? JSON.stringify({
              nodes: [{
                id: "background",
                role: "background",
                bbox: [0, 0, 1000, 1000],
                confidence: 1,
                zIndex: 0,
                label: "full canvas",
                extractionHints: [],
              }],
              relations: [],
            })
          : undefined;
      assert.notEqual(text, undefined, "test bridge advertises only OCR and scene");
      await publishResponse(requestDirectory, {
        version: 1,
        requestId: request.requestId,
        status: "success",
        model: `fixture-host-${request.operation}`,
        text,
      });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  if (settled === undefined) throw new Error("child CLI did not finish in time");
  return { result: settled, requests };
}

test("real child CLI uses a no-credential file bridge and builds real v2 artifacts without network", { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ppt-child-bridge-"));
  const bridgeDirectory = join(root, "bridge");
  const analysisDirectory = join(root, "analysis");
  const outputDirectory = join(root, "output");
  const preloadPath = join(root, "deny-network.mjs");
  const networkMarker = join(root, "network-attempted");
  const children = new Set<ChildProcessWithoutNullStreams>();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await rm(root, { recursive: true, force: true });
  });

  await chmod(root, 0o700);
  await writeFile(preloadPath, `
import { appendFile } from "node:fs/promises";
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () => {
    await appendFile(${JSON.stringify(networkMarker)}, "fetch\\n");
    throw new Error("network is disabled by the child CLI acceptance test");
  },
});
`, { mode: 0o600 });
  await mkdir(bridgeDirectory);
  await chmod(bridgeDirectory, 0o700);
  await writeFile(join(bridgeDirectory, "capabilities.json"), JSON.stringify({
    version: 1,
    providers: {
      openai: { callable: true, operations: ["ocr", "scene"] },
    },
  }), { mode: 0o600 });

  const env = credentialFreeEnvironment(preloadPath);
  const analyze = launchCli([
    "analyze",
    resolve("tests/fixtures/semantic/canvas-16x9.png"),
    "--out",
    analysisDirectory,
    "--host-bridge",
    bridgeDirectory,
    "--max-region-analysis",
    "0",
    "--max-occlusion-completions",
    "0",
  ], env);
  children.add(analyze.child);
  const serviced = await serviceBridgeUntilExit(bridgeDirectory, analyze.result);
  children.delete(analyze.child);
  assert.deepEqual(serviced.result, { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(serviced.requests.map(({ operation }) => operation), ["ocr", "scene"]);

  const analysis = await readAnalysisPackage(analysisDirectory);
  assert.equal(analysis.analysisVersion, 2);
  if (analysis.analysisVersion !== 2) return;
  assert.deepEqual(analysis.canvas, { width: 320, height: 180 });
  assert.deepEqual(analysis.requests, {
    ocr: 1,
    fullVision: 1,
    regionalVision: 0,
    completion: 0,
  });
  assert.deepEqual(analysis.routing?.operations.map((operation) => ({
    operation: operation.operation,
    candidate: operation.selectedCandidate,
    model: operation.selectedModel,
  })), [
    { operation: "ocr", candidate: "host-openai", model: "fixture-host-ocr" },
    { operation: "scene", candidate: "host-openai", model: "fixture-host-scene" },
  ]);

  const build = launchCli([
    "build",
    "--analysis",
    analysisDirectory,
    "--out",
    outputDirectory,
  ], env);
  children.add(build.child);
  const buildResult = await build.result;
  children.delete(build.child);
  assert.deepEqual(buildResult, { code: 0, stdout: "", stderr: "" });
  await assert.rejects(access(networkMarker), /ENOENT/);

  const manifest = JSON.parse(
    await readFile(join(outputDirectory, "manifest.json"), "utf8"),
  ) as { manifestVersion: number; canvas: { width: number; height: number } };
  assert.equal(manifest.manifestVersion, 2);
  assert.deepEqual(manifest.canvas, { width: 320, height: 180 });
  for (const artifact of [
    "slide-editable.pptx",
    "recomposition-preview.png",
    "layer-review.png",
    "exploded-preview.png",
    "run-ledger.json",
  ]) {
    assert.ok((await stat(join(outputDirectory, artifact))).size > 0, artifact);
  }
  assert.deepEqual(
    (await readFile(join(outputDirectory, "slide-editable.pptx"))).subarray(0, 2),
    Buffer.from("PK"),
  );
});
