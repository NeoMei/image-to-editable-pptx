import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("dependency audit does not leak npm-run allowScripts config into nested npm", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "image-editable-audit-env-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fakeNpm = join(root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
const leaked = Object.keys(process.env).some(
  (key) => key.toLowerCase() === "npm_config_allow_scripts",
);
if (leaked) {
  process.stderr.write("allowScripts config leaked\\n");
  process.exit(1);
}
`, { mode: 0o600 });

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["scripts/audit-dependencies.mjs"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        npm_execpath: fakeNpm,
        npm_config_allow_scripts: "opencode-ai",
      },
    },
  );

  assert.equal(stdout, "Dependency audit passed with no known vulnerabilities.\n");
  assert.equal(stderr, "");
});

test("npm pack dry-run ships the complete runtime without tests, fixtures, or local state", async () => {
  const npmExecPath = process.env.npm_execpath;
  const fallbackNpmExecPath = process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : undefined;
  const nodeDrivenNpm = npmExecPath ?? fallbackNpmExecPath;
  const { stdout, stderr } = await execFileAsync(
    nodeDrivenNpm ? process.execPath : "npm",
    [
      ...(nodeDrivenNpm ? [nodeDrivenNpm] : []),
      "pack",
      "--dry-run",
      "--json",
      "--ignore-scripts",
    ],
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
