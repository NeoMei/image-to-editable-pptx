import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseCliArgs } from "../src/cli.js";

test("packages the project as the approved Codex plugin", async () => {
  const [packageJson, pluginJson, packageLock] = await Promise.all([
    readJson("package.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson("package-lock.json"),
  ]);

  assert.equal(pluginJson.name, "image-to-editable-pptx");
  assert.equal(pluginJson.version, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(pluginJson.skills, "./skills/");
  assert.equal(
    pluginJson.repository,
    "https://github.com/NeoMei/image-to-editable-pptx",
  );
  assert.equal(pluginJson.license, "MIT");
  assert.equal(pluginJson.interface.displayName, "Image to Editable PPTX");
});

test("publishes a Git-backed Codex marketplace entry", async () => {
  const marketplace = await readJson(".agents/plugins/marketplace.json");

  assert.equal(marketplace.name, "image-to-editable-pptx");
  assert.deepEqual(marketplace.plugins, [
    {
      name: "image-to-editable-pptx",
      source: {
        source: "url",
        url: "https://github.com/NeoMei/image-to-editable-pptx.git",
        ref: "main",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    },
  ]);
});

test("ships a discoverable skill without scaffold placeholders", async () => {
  const [skill, license] = await Promise.all([
    readFile("skills/image-to-editable-pptx/SKILL.md", "utf8"),
    readFile("LICENSE", "utf8"),
  ]);

  assert.match(skill, /^name: image-to-editable-pptx$/m);
  assert.match(skill, /DASHSCOPE_API_KEY/);
  assert.doesNotMatch(skill, /\[TODO:/);
  assert.match(license, /^MIT License$/m);
});

test("ships runtime, plugin metadata, and the installed skill in the npm package", async () => {
  const packageJson = await readJson("package.json");
  const included = new Set(packageJson.files as string[]);

  assert.equal(packageJson.private, false);
  assert.ok(included.has("src/"));
  assert.ok(included.has("skills/"));
  assert.ok(included.has(".codex-plugin/"));
  assert.ok(included.has("README.md"));
});

test("documents executable bounded analysis and source-free offline build examples", async () => {
  const [readme, skill] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("skills/image-to-editable-pptx/SKILL.md", "utf8"),
  ]);

  for (const document of [readme, skill]) {
    assert.match(document, /\.png/i);
    assert.match(document, /\.jpe?g/i);
    assert.match(document, /64/);
    assert.match(document, /8192/);
    assert.match(document, /40[,.]?000[,.]?000/);
    assert.match(document, /50\s*MiB/i);
    assert.match(document, /56\s*:\s*1/);
    assert.match(document, /--max-region-analysis/);
    assert.match(document, /--max-occlusion-completions/);
    assert.match(document, /manifest\s*v?2/i);
    assert.match(document, /recomposition-preview\.png/);
    assert.match(document, /layer-review\.png/);
    assert.match(document, /exploded-preview\.png/);
    assert.match(document, /reviewRequired/);
    assert.match(document, /offline|\u79bb\u7ebf/i);
    assert.match(document, /text backing|\u6587\u5b57\u5e95\u677f/i);
    assert.match(document, /PNG/);
    assert.match(document, /fallback|\u56de\u9000|\u4fdd\u7559.*\u80cc\u666f/i);

    const promotedBuild = extractCliInvocation(document, "build");
    assert.ok(promotedBuild, "document must include an offline build example");
    assert.doesNotMatch(promotedBuild, /--image/);
    assert.doesNotMatch(promotedBuild, /<source|<image|<png|<jpeg/i);
  }

  assert.doesNotThrow(() =>
    parseCliArgs([
      "analyze", "slide.jpg", "--out", "analysis",
      "--max-region-analysis", "8",
      "--max-occlusion-completions", "4",
    ]),
  );
  assert.doesNotThrow(() =>
    parseCliArgs(["build", "--analysis", "analysis", "--out", "output"]),
  );
});

test("plugin metadata describes generic PNG and JPEG semantic reconstruction", async () => {
  const pluginJson = await readJson(".codex-plugin/plugin.json");
  const metadata = [
    pluginJson.description,
    pluginJson.interface.shortDescription,
    pluginJson.interface.longDescription,
    pluginJson.interface.defaultPrompt,
  ].join(" ");

  assert.match(metadata, /PNG/i);
  assert.match(metadata, /JPEG/i);
  assert.match(metadata, /semantic|editable/i);
  assert.doesNotMatch(metadata, /1280\s*[x\u00d7]\s*720/);
});

test("documents an OpenCode-compatible skill installation", async () => {
  const [readme, skill] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("skills/image-to-editable-pptx/SKILL.md", "utf8"),
  ]);

  assert.match(readme, /^## 安装 OpenCode Skill$/m);
  assert.match(readme, /\$HOME\/\.agents\/skills\/image-to-editable-pptx/);
  assert.match(readme, /opencode debug skill/);
  assert.match(
    readme,
    /OpenCode.*Codex Marketplace.*不兼容|Codex Marketplace.*OpenCode.*不兼容/s,
  );
  assert.match(skill, /supports Codex and OpenCode/);
  assert.match(skill, /physical path.*symbolic link|symbolic link.*physical path/is);
});

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

function extractCliInvocation(document: string, command: string): string | undefined {
  return document
    .split("\n")
    .find((line) => line.includes(`npm run cli -- ${command} `));
}
