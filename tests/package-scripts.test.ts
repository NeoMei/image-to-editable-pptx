import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
