import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("scopes source and compiled test scripts to their own trees", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    name: string;
    description: string;
    engines: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.name, "image-to-editable-pptx");
  assert.match(packageJson.description, /PNG/i);
  assert.match(packageJson.description, /JPEG/i);
  assert.match(packageJson.description, /editable/i);
  assert.equal(packageJson.engines.node, ">=22.6");
  assert.equal(
    packageJson.scripts.test,
    'node --import tsx --test "tests/*.test.ts"',
  );
  assert.equal(
    packageJson.scripts["test:compiled"],
    'node --experimental-detect-module --test "dist/tests/*.test.js"',
  );
});

test("uses the approved product name in the public README", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /^# Image to Editable PPTX$/m);
  assert.match(readme, /High-fidelity/i);
  assert.match(readme, /PPTX/);
  assert.match(readme, /editable|可编辑/i);
});

test("uses the patched Sharp line for untrusted slide images", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };

  assert.equal(packageJson.dependencies.sharp, "^0.35.3");
});

test("npm pack dry-run ships the complete runtime without tests, fixtures, or local state", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(stderr, "");
  const report: unknown = JSON.parse(stdout);
  const reportEntries = Array.isArray(report)
    ? report
    : Object.values(report ?? {});
  const firstEntry = reportEntries[0] as
    | { files?: Array<{ path: string }> }
    | undefined;
  const files = firstEntry?.files?.map(({ path }) => path).sort() ?? [];
  for (const required of [
    "package.json",
    "src/cli.ts",
    "src/pipeline.ts",
    "src/analysis/package.ts",
    "src/fidelity/build.ts",
    ".codex-plugin/plugin.json",
    "skills/image-to-editable-pptx/SKILL.md",
    "skills/image-to-editable-pptx/agents/openai.yaml",
  ]) {
    assert.ok(files.includes(required), `missing packaged runtime file: ${required}`);
  }
  for (const path of files) {
    assert.doesNotMatch(path, /^(?:tests|dist|\.superpowers|node_modules)\//);
    assert.doesNotMatch(path, /fixture|secret|\.env|\.DS_Store/i);
    assert.equal(path.startsWith("/"), false, `absolute package path: ${path}`);
    assert.doesNotMatch(path, /^[A-Za-z]:[\\/]/);
  }
  const readableFiles = files.filter((path) =>
    /\.(?:json|md|sh|ts|ya?ml)$/.test(path),
  );
  for (const path of readableFiles) {
    const content = await readFile(path, "utf8");
    assert.doesNotMatch(content, /\/Users\/[A-Za-z0-9._-]+\//, path);
    assert.doesNotMatch(content, /\bsk-[a-z0-9_-]{24,}\b/i, path);
    assert.doesNotMatch(content, /\bLTAI[a-z0-9]{12,}\b/i, path);
  }
});
