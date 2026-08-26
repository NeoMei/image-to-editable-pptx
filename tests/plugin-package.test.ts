import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("packages the project as the approved Codex plugin", async () => {
  const [packageJson, pluginJson] = await Promise.all([
    readJson("package.json"),
    readJson(".codex-plugin/plugin.json"),
  ]);

  assert.equal(pluginJson.name, "image-to-editable-pptx");
  assert.equal(pluginJson.version, packageJson.version);
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
