import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scopes source and compiled test scripts to their own trees", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    engines: Record<string, string>;
    scripts: Record<string, string>;
  };

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

test("uses the patched Sharp line for untrusted slide images", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };

  assert.equal(packageJson.dependencies.sharp, "^0.35.3");
});
