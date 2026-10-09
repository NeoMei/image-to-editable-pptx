import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import { parseCliArgs, runCli } from "../src/cli.js";
import {
  applyRasterPatchPptx,
  patchRasterPptxFile,
  type RasterPatchSpec,
} from "../src/raster-patch.js";

async function makeArchive(): Promise<Buffer> {
  const image = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 4,
      background: { r: 240, g: 240, b: 240, alpha: 1 },
    },
  }).png().toBuffer();
  return new JSZip()
    .file("ppt/media/image1.png", image)
    .file("ppt/slides/slide1.xml", "slide-content")
    .file("custom/untouched.bin", Buffer.from([1, 2, 3, 4]))
    .generateAsync({ type: "nodebuffer" });
}

const patch: RasterPatchSpec = {
  mediaPath: "ppt/media/image1.png",
  region: { x: 20, y: 15, width: 70, height: 45 },
  background: "#ffffff",
  scale: 3,
  texts: [
    {
      text: "异常企业排行",
      box: { x: 5, y: 5, width: 60, height: 18 },
      fontSize: 12,
      color: "#111827",
      fontWeight: "700",
      align: "left",
    },
  ],
};

test("parses the raster-patch command with an explicit patch spec", () => {
  assert.deepEqual(
    parseCliArgs([
      "raster-patch",
      "source.pptx",
      "--patch",
      "patch.json",
      "--out",
      "patched.pptx",
    ]),
    {
      command: "raster-patch",
      pptx: "source.pptx",
      patch: "patch.json",
      out: "patched.pptx",
    },
  );
});

test("dispatches raster-patch without entering provider-backed pipeline stages", async () => {
  let received: string[] | undefined;
  await runCli(
    ["raster-patch", "source.pptx", "--patch", "patch.json", "--out", "patched.pptx"],
    {},
    {
      analyze: async () => { throw new Error("analyze must not run"); },
      build: async () => { throw new Error("build must not run"); },
      run: async () => { throw new Error("run must not run"); },
      rasterPatch: async (...paths) => { received = paths; },
    },
  );
  assert.deepEqual(received, ["source.pptx", "patch.json", "patched.pptx"]);
});

test("replaces only the selected media entry and keeps other archive entries intact", async () => {
  const source = await makeArchive();
  const result = await applyRasterPatchPptx(source, patch);
  const before = await JSZip.loadAsync(source);
  const after = await JSZip.loadAsync(result.output);

  assert.notDeepEqual(
    await after.file("ppt/media/image1.png")!.async("nodebuffer"),
    await before.file("ppt/media/image1.png")!.async("nodebuffer"),
  );
  assert.deepEqual(
    await after.file("ppt/slides/slide1.xml")!.async("nodebuffer"),
    await before.file("ppt/slides/slide1.xml")!.async("nodebuffer"),
  );
  assert.deepEqual(
    await after.file("custom/untouched.bin")!.async("nodebuffer"),
    Buffer.from([1, 2, 3, 4]),
  );

  const metadata = await sharp(
    await after.file("ppt/media/image1.png")!.async("nodebuffer"),
  ).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, {
    width: 120,
    height: 80,
  });
});

test("rejects media paths outside ppt/media and patches outside the source image", async () => {
  const source = await makeArchive();
  await assert.rejects(
    () => applyRasterPatchPptx(source, { ...patch, mediaPath: "ppt/slides/slide1.xml" }),
    /mediaPath must point to a file under ppt\/media\//,
  );
  await assert.rejects(
    () => applyRasterPatchPptx(source, {
      ...patch,
      region: { x: 80, y: 15, width: 70, height: 45 },
    }),
    /region must be contained within the source image/,
  );
});

test("patchRasterPptxFile reads a JSON plan and writes the patched archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raster-patch-"));
  try {
    const input = join(directory, "source.pptx");
    const plan = join(directory, "patch.json");
    const output = join(directory, "patched.pptx");
    await writeFile(input, await makeArchive());
    await writeFile(plan, JSON.stringify(patch), "utf8");

    const result = await patchRasterPptxFile(input, plan, output);

    assert.equal(result.mediaPath, patch.mediaPath);
    assert.ok(result.changedBytes > 0);
    assert.deepEqual(await readFile(output), result.output);
    assert.equal(result.outputBytes, result.output.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
