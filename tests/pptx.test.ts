import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";
import sharp from "sharp";

import type { SlideManifest, SlideManifestV2 } from "../src/contracts.js";
import { exportPptx } from "../src/export/pptx.js";

const EMU_PER_INCH = 914_400;

function xmlAttribute(source: string, element: string, attribute: string): number {
  const match = source.match(
    new RegExp(`<${element}[^>]*\\b${attribute}="(\\d+)"`),
  );
  assert.ok(match, `missing ${attribute} on ${element}`);
  return Number(match[1]);
}

test("exports one editable wide slide with ordered, named PowerPoint layers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pptx-export-"));
  const backgroundPath = join(directory, "background.png");
  const firstAssetPath = join(directory, "asset-one.png");
  const secondAssetPath = join(directory, "asset-two.png");
  const outputPath = join(directory, "synthetic.pptx");

  try {
    await Promise.all([
      sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 4,
          background: "#F5EFE4",
        },
      })
        .png()
        .toFile(backgroundPath),
      sharp({
        create: {
          width: 32,
          height: 32,
          channels: 4,
          background: "#CC3300",
        },
      })
        .png()
        .toFile(firstAssetPath),
      sharp({
        create: {
          width: 24,
          height: 24,
          channels: 4,
          background: "#0066CC",
        },
      })
        .png()
        .toFile(secondAssetPath),
    ]);

    const manifest: SlideManifest = {
      manifestVersion: 1,
      canvas: { width: 1280, height: 720 },
      warnings: [],
      elements: [
        {
          kind: "shape",
          id: "panel",
          label: "synthetic panel",
          shape: "rect",
          bbox: { x: 64, y: 72, width: 640, height: 360 },
          fillColor: "F4EBDD",
          strokeColor: "23394D",
          strokeWidthPx: 2,
          cornerRadiusPx: 0,
          zIndex: 1,
        },
        {
          kind: "text",
          id: "title",
          text: "Editable 标题",
          bbox: { x: 128, y: 96, width: 480, height: 64 },
          rotation: 0,
          color: "23394D",
          fontSizePx: 32,
          charSpacingPx: 3,
          bold: true,
          align: "center",
          zIndex: 2,
        },
        {
          kind: "asset",
          id: "icon-one",
          label: "first icon",
          bbox: { x: 760, y: 180, width: 96, height: 96 },
          extraction: "transparent",
          assetPath: firstAssetPath,
          zIndex: 3,
        },
        {
          kind: "asset",
          id: "icon-two",
          label: "second icon",
          bbox: { x: 900, y: 300, width: 72, height: 72 },
          extraction: "transparent",
          assetPath: secondAssetPath,
          zIndex: 4,
        },
      ],
    };

    await exportPptx(manifest, backgroundPath, outputPath);

    const archive = await JSZip.loadAsync(await readFile(outputPath));
    const slideFiles = Object.keys(archive.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    assert.deepEqual(slideFiles, ["ppt/slides/slide1.xml"]);

    const presentationXml = await archive
      .file("ppt/presentation.xml")!
      .async("string");
    const slideWidth = xmlAttribute(presentationXml, "p:sldSz", "cx");
    const slideHeight = xmlAttribute(presentationXml, "p:sldSz", "cy");
    assert.ok(Math.abs(slideWidth / EMU_PER_INCH - 13.333) < 0.001);
    assert.ok(Math.abs(slideHeight / EMU_PER_INCH - 7.5) < 0.001);

    const slideXml = await archive.file(slideFiles[0]!)!.async("string");
    assert.match(slideXml, /<a:t>Editable 标题<\/a:t>/);
    assert.match(slideXml, /<a:prstGeom prst="rect">/);
    assert.match(slideXml, /typeface="Microsoft YaHei"/);
    assert.match(slideXml, /<a:rPr\b[^>]*\bb="1"/);
    assert.match(slideXml, /<a:rPr\b[^>]*\bspc="225"/);
    const trackedTextXml = slideXml.slice(
      slideXml.lastIndexOf("<p:sp>", slideXml.indexOf('name="text-title"')),
      slideXml.indexOf("</p:sp>", slideXml.indexOf('name="text-title"')) +
        "</p:sp>".length,
    );
    assert.equal(
      xmlAttribute(trackedTextXml, "a:ext", "cx"),
      Math.round(((480 + 16) * 13.333 * EMU_PER_INCH) / 1280),
    );
    assert.match(slideXml, /<a:bodyPr\b[^>]*\banchor="ctr"/);
    assert.doesNotMatch(slideXml, /<a:(?:normAutofit|spAutoFit)\b/);

    const generatedNames = Array.from(
      slideXml.matchAll(/<p:cNvPr\b[^>]*\bname="([^"]+)"/g),
      (match) => match[1]!,
    ).filter((name) => name !== "");
    assert.deepEqual(generatedNames, [
      "asset-background",
      "shape-panel-synthetic panel",
      "text-title",
      "asset-icon-one",
      "asset-icon-two",
    ]);
    assert.ok(
      generatedNames.every((name) => /^(?:text|shape|asset)-/.test(name)),
    );

    const backgroundIndex = slideXml.indexOf('name="asset-background"');
    assert.ok(backgroundIndex >= 0);
    for (const name of generatedNames.slice(1)) {
      assert.ok(backgroundIndex < slideXml.indexOf(`name="${name}"`));
    }
    const backgroundXml = slideXml.slice(
      slideXml.lastIndexOf("<p:pic>", backgroundIndex),
      slideXml.indexOf("</p:pic>", backgroundIndex) + "</p:pic>".length,
    );
    assert.match(backgroundXml, /<a:off x="0" y="0"\/>/);
    assert.equal(
      xmlAttribute(backgroundXml, "a:ext", "cx"),
      Math.round(13.333 * EMU_PER_INCH),
    );
    assert.equal(
      xmlAttribute(backgroundXml, "a:ext", "cy"),
      Math.round(((720 * 13.333) / 1280) * EMU_PER_INCH),
    );

    const assetRelationships = new Map(
      Array.from(
        slideXml.matchAll(
          /<p:pic>[\s\S]*?<p:cNvPr\b[^>]*\bname="(asset-[^"]+)"[\s\S]*?<a:blip r:embed="(rId\d+)"/g,
        ),
        (match) => [match[1]!, match[2]!] as const,
      ),
    );
    assert.deepEqual([...assetRelationships.keys()], [
      "asset-background",
      "asset-icon-one",
      "asset-icon-two",
    ]);
    assert.equal(new Set(assetRelationships.values()).size, 3);

    const relationshipsXml = await archive
      .file("ppt/slides/_rels/slide1.xml.rels")!
      .async("string");
    for (const relationshipId of assetRelationships.values()) {
      assert.match(
        relationshipsXml,
        new RegExp(
          `<Relationship[^>]*\\bId="${relationshipId}"[^>]*\\bType="[^"]*/image"[^>]*\\bTarget="[^"]+"`,
        ),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exports manifest v2 through one custom portrait transform", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pptx-export-portrait-"));
  const backgroundPath = join(directory, "background.png");
  const assetPath = join(directory, "asset.png");
  const outputPath = join(directory, "portrait.pptx");

  try {
    await Promise.all([
      sharp({
        create: {
          width: 900,
          height: 1600,
          channels: 4,
          background: "#f5efe4",
        },
      }).png().toFile(backgroundPath),
      sharp({
        create: {
          width: 450,
          height: 800,
          channels: 4,
          background: "#23394d",
        },
      }).png().toFile(assetPath),
    ]);
    const zeroHash = "0".repeat(64);
    const manifest: SlideManifestV2 = {
      manifestVersion: 2,
      canvas: { width: 900, height: 1600 },
      warnings: [],
      elements: [
        {
          kind: "asset",
          id: "portrait-object",
          label: "audit label",
          bbox: { x: 90, y: 160, width: 450, height: 800 },
          extraction: "transparent",
          assetPath,
          zIndex: 1,
          role: "foreground-object",
          groupId: null,
          provenance: {
            kind: "source-visible",
            sourceCropSha256: zeroHash,
            visibleMaskSha256: zeroHash,
            assetSha256: zeroHash,
          },
          relations: [],
          reviewRequired: false,
        },
        {
          kind: "text",
          id: "portrait-text",
          text: "Portrait editable",
          bbox: { x: 180, y: 320, width: 360, height: 160 },
          rotation: 0,
          color: "FFFFFF",
          fontSizePx: 32,
          align: "left",
          zIndex: 2,
        },
      ],
    };

    await exportPptx(manifest, backgroundPath, outputPath);

    const archive = await JSZip.loadAsync(await readFile(outputPath));
    const presentationXml = await archive
      .file("ppt/presentation.xml")!
      .async("string");
    const slideWidth = xmlAttribute(presentationXml, "p:sldSz", "cx");
    const slideHeight = xmlAttribute(presentationXml, "p:sldSz", "cy");
    assert.ok(Math.abs(slideWidth / EMU_PER_INCH - 7.4998125) < 0.001);
    assert.ok(Math.abs(slideHeight / EMU_PER_INCH - 13.333) < 0.001);

    const slideXml = await archive.file("ppt/slides/slide1.xml")!.async("string");
    const namedTransform = (name: string, tag: "p:pic" | "p:sp"): string => {
      const nameIndex = slideXml.indexOf(`name="${name}"`);
      assert.ok(nameIndex >= 0, `missing ${name}`);
      return slideXml.slice(
        slideXml.lastIndexOf(`<${tag}>`, nameIndex),
        slideXml.indexOf(`</${tag}>`, nameIndex) + `</${tag}>`.length,
      );
    };
    const backgroundXml = namedTransform("asset-background", "p:pic");
    const assetXml = namedTransform("asset-portrait-object", "p:pic");
    const textXml = namedTransform("text-portrait-text", "p:sp");
    const page = { width: slideWidth, height: slideHeight };
    for (const item of [backgroundXml, assetXml, textXml]) {
      const x = xmlAttribute(item, "a:off", "x");
      const y = xmlAttribute(item, "a:off", "y");
      const width = xmlAttribute(item, "a:ext", "cx");
      const height = xmlAttribute(item, "a:ext", "cy");
      assert.ok(x >= 0 && y >= 0);
      assert.ok(x + width <= page.width + 1);
      assert.ok(y + height <= page.height + 1);
    }
    assert.equal(
      xmlAttribute(assetXml, "a:off", "x"),
      Math.round(0.74998125 * EMU_PER_INCH),
    );
    assert.equal(
      xmlAttribute(assetXml, "a:off", "y"),
      Math.round(1.3333 * EMU_PER_INCH),
    );
    assert.equal(
      xmlAttribute(assetXml, "a:ext", "cx"),
      Math.round(3.74990625 * EMU_PER_INCH),
    );
    assert.equal(
      xmlAttribute(assetXml, "a:ext", "cy"),
      Math.round(6.6665 * EMU_PER_INCH),
    );
    assert.match(textXml, /<a:rPr\b[^>]*\bsz="1920"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to export a rectangular fidelity asset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pptx-export-rectangular-"));
  const backgroundPath = join(directory, "background.png");
  const assetPath = join(directory, "asset.png");
  const outputPath = join(directory, "synthetic.pptx");

  try {
    await Promise.all([
      sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 4,
          background: "#F5EFE4",
        },
      }).png().toFile(backgroundPath),
      sharp({
        create: {
          width: 32,
          height: 32,
          channels: 4,
          background: "#CC3300",
        },
      }).png().toFile(assetPath),
    ]);
    const manifest: SlideManifest = {
      manifestVersion: 1,
      canvas: { width: 1280, height: 720 },
      warnings: [],
      elements: [{
        kind: "asset",
        id: "unsafe-icon",
        label: "unsafe icon",
        bbox: { x: 100, y: 100, width: 32, height: 32 },
        extraction: "rectangular",
        assetPath,
        zIndex: 1,
      }],
    };

    await assert.rejects(
      exportPptx(manifest, backgroundPath, outputPath),
      /Refusing to export rectangular fidelity asset unsafe-icon/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses an asset outside the PPTX output staging directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pptx-export-path-"));
  const stagingDirectory = join(directory, "staging");
  const backgroundPath = join(stagingDirectory, "background.png");
  const externalAssetPath = join(directory, "external-asset.png");
  const outputPath = join(stagingDirectory, "synthetic.pptx");

  try {
    await mkdir(stagingDirectory);
    await Promise.all([
      sharp({
        create: {
          width: 1280,
          height: 720,
          channels: 4,
          background: "#f5efe4",
        },
      }).png().toFile(backgroundPath),
      sharp({
        create: {
          width: 32,
          height: 32,
          channels: 4,
          background: "#cc3300",
        },
      }).png().toFile(externalAssetPath),
    ]);
    const manifest: SlideManifest = {
      manifestVersion: 1,
      canvas: { width: 1280, height: 720 },
      warnings: [],
      elements: [{
        kind: "asset",
        id: "external-icon",
        label: "external icon",
        bbox: { x: 100, y: 100, width: 32, height: 32 },
        extraction: "transparent",
        assetPath: externalAssetPath,
        zIndex: 1,
      }],
    };

    await assert.rejects(
      exportPptx(manifest, backgroundPath, outputPath),
      /asset escapes pptx output staging/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
