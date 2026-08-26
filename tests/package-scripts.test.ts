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
  assert.equal(
    packageJson.description,
    "Convert slide images into high-fidelity PPTX files with editable text and selected elements.",
  );
  assert.equal(packageJson.engines.node, ">=22.6");
  assert.equal(
    packageJson.scripts.test,
    'node --import tsx --test "tests/*.test.ts"',
  );
  assert.equal(
    packageJson.scripts["test:compiled"],
    'node --test "dist/tests/*.test.js"',
  );
});

test("uses the approved product name in the public README", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /^# Image to Editable PPTX$/m);
  assert.match(readme, /High-fidelity image-to-editable slides/);
  assert.match(readme, /高保真图片式 PPT 可编辑重构/);
});

test("uses the patched Sharp line for untrusted slide images", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };

  assert.equal(packageJson.dependencies.sharp, "^0.35.3");
});
