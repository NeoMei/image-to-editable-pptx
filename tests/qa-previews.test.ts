import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import type { SlideManifestV2 } from "../src/contracts.js";
import type { BuiltAsset } from "../src/fidelity/build.js";
import type { SourceCanvas } from "../src/image/source.js";
import { writeQaPreviews } from "../src/qa/previews.js";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<{
  canvas: SourceCanvas;
  background: Buffer;
  assets: BuiltAsset[];
  manifest: SlideManifestV2;
}> {
  const width = 96;
  const height = 64;
  const background = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: "#f7f3e9",
    },
  }).png().toBuffer();
  const visible = await sharp({
    create: {
      width: 12,
      height: 12,
      channels: 4,
      background: "#23394d",
    },
  }).png().toBuffer();
  const generated = await sharp({
    create: {
      width: 14,
      height: 12,
      channels: 4,
      background: "#e65d16",
    },
  }).png().toBuffer();
  const emptyRemovalMask = await sharp(Buffer.alloc(width * height), {
    raw: { width, height, channels: 1 },
  }).png().toBuffer();
  const zeroHash = "0".repeat(64);
  const assets: BuiltAsset[] = [
    {
      candidateId: "node-visible",
      assetPath: "assets/asset-visible.png",
      image: visible,
      bbox: { x: 10, y: 12, width: 12, height: 12 },
      removalMask: emptyRemovalMask,
      zIndex: 1,
      reviewRequired: false,
      provenance: {
        kind: "source-visible",
        sourceCropSha256: zeroHash,
        visibleMaskSha256: zeroHash,
        assetSha256: sha256(visible),
      },
    },
    {
      candidateId: "node-generated",
      assetPath: "assets/asset-generated.png",
      image: generated,
      bbox: { x: 42, y: 26, width: 14, height: 12 },
      removalMask: emptyRemovalMask,
      zIndex: 2,
      reviewRequired: true,
      provenance: {
        kind: "composite",
        sourceCropSha256: zeroHash,
        visibleMaskSha256: zeroHash,
        generatedMaskSha256: zeroHash,
        assetSha256: sha256(generated),
        modelId: "fixture-model",
        taskIdSha256: zeroHash,
      },
    },
  ];
  const manifestAssets: SlideManifestV2["elements"] = assets.map((asset, index) => ({
    kind: "asset" as const,
    id: asset.candidateId,
    label: index === 0 ? "label must not affect QA" : "another ignored label",
    bbox: asset.bbox,
    extraction: "transparent" as const,
    assetPath: asset.assetPath,
    zIndex: asset.zIndex,
    role: index === 0 ? "foreground-object" as const : "compound-group" as const,
    groupId: index === 0 ? null : "group-stable",
    provenance: asset.provenance,
    relations: [],
    reviewRequired: asset.reviewRequired,
  }));
  const manifest: SlideManifestV2 = {
    manifestVersion: 2,
    canvas: { width, height },
    warnings: [],
    // Deliberately not in z-order: QA recomposition must use zIndex, not input
    // array order, just like the slide scene does.
    elements: [
      {
        kind: "text",
        id: "text-qa",
        text: "文",
        bbox: { x: 68, y: 42, width: 24, height: 14 },
        rotation: 0,
        color: "112233",
        fontSizePx: 14,
        charSpacingPx: 0,
        bold: false,
        align: "left",
        zIndex: 3,
      },
      manifestAssets[1]!,
      manifestAssets[0]!,
      {
        kind: "shape",
        id: "shape-panel",
        label: "audit-only shape label",
        shape: "rect",
        bbox: { x: 4, y: 4, width: 30, height: 26 },
        fillColor: "4488CC",
        strokeColor: "224466",
        strokeWidthPx: 2,
        cornerRadiusPx: 0,
        zIndex: 0,
      },
    ],
  };
  const rgba = await sharp(background).ensureAlpha().raw().toBuffer();
  // The source retains the glyph while the clean background above does not.
  // Put its distinctive right-hand stroke beyond the deterministic fallback
  // glyph so the assertion proves source-derived text restoration.
  for (let y = 44; y <= 53; y += 1) {
    rgba.set([17, 34, 51, 255], (y * width + 88) * 4);
  }
  for (let x = 82; x <= 89; x += 1) {
    rgba.set([17, 34, 51, 255], (48 * width + x) * 4);
  }
  const sourceBytes = await sharp(rgba, {
    raw: { width, height, channels: 4 },
  }).png().toBuffer();
  return {
    canvas: { format: "png", width, height, rgba, sourceBytes },
    background,
    assets,
    manifest,
  };
}

function countReviewRed(data: Buffer, channels: number): number {
  let count = 0;
  for (let offset = 0; offset < data.length; offset += channels) {
    if (
      data[offset]! >= 180 &&
      data[offset + 1]! <= 90 &&
      data[offset + 2]! <= 90
    ) {
      count += 1;
    }
  }
  return count;
}

test("writes deterministic recomposition, checkerboard review, and exploded QA previews", async () => {
  const firstDirectory = await mkdtemp(join(tmpdir(), "semantic-qa-first-"));
  const secondDirectory = await mkdtemp(join(tmpdir(), "semantic-qa-second-"));
  try {
    const input = await fixture();
    const originalAssetHashes = input.assets.map(({ image }) => sha256(image));
    const first = await writeQaPreviews({ ...input, outDir: firstDirectory });
    const relabeledManifest: SlideManifestV2 = {
      ...input.manifest,
      elements: input.manifest.elements.map((element) => ({
        ...element,
        ...(element.kind === "asset"
          ? { label: `changed audit label for ${element.id}` }
          : {}),
      })),
    };
    const second = await writeQaPreviews({
      ...input,
      manifest: relabeledManifest,
      outDir: secondDirectory,
    });

    assert.deepEqual(
      first.map(({ kind, path }) => [kind, basename(path)]),
      [
        ["recomposition", "recomposition-preview.png"],
        ["layer-review", "layer-review.png"],
        ["exploded", "exploded-preview.png"],
      ],
    );
    assert.deepEqual(
      first.map(({ sha256: hash }) => hash),
      second.map(({ sha256: hash }) => hash),
      "node labels and roles, not model audit labels, define QA annotations",
    );
    for (const record of first) {
      const bytes = await readFile(record.path);
      assert.match(record.sha256, /^[a-f0-9]{64}$/);
      assert.equal(record.sha256, sha256(bytes));
    }
    assert.deepEqual(
      input.assets.map(({ image }) => sha256(image)),
      originalAssetHashes,
      "QA markers never mutate exported asset bytes",
    );

    const recomposition = await sharp(first[0]!.path)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(recomposition.info.width, 96);
    assert.equal(recomposition.info.height, 64);
    const generatedCenter = (32 * recomposition.info.width + 49) * 4;
    assert.deepEqual(
      [...recomposition.data.subarray(generatedCenter, generatedCenter + 4)],
      [230, 93, 22, 255],
      "normal recomposition does not burn the QA review marker into an asset",
    );

    const layerReview = await sharp(first[1]!.path)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(layerReview.info.width, 640);
    assert.equal(layerReview.info.height, 220);
    const firstChecker = (8 * layerReview.info.width + 4) * 4;
    const secondChecker = (8 * layerReview.info.width + 20) * 4;
    assert.notDeepEqual(
      [...layerReview.data.subarray(firstChecker, firstChecker + 4)],
      [...layerReview.data.subarray(secondChecker, secondChecker + 4)],
      "the review sheet exposes transparency over a checkerboard",
    );
    assert.ok(
      countReviewRed(layerReview.data, layerReview.info.channels) > 100,
      "generated content has a visible QA-only review marker",
    );
    const generatedInterior = (96 * layerReview.info.width + 406) * 4;
    const highlighted = [
      ...layerReview.data.subarray(generatedInterior, generatedInterior + 4),
    ];
    assert.notDeepEqual(
      highlighted,
      [230, 93, 22, 255],
      "the generated pixel region itself is visibly highlighted",
    );
    assert.ok(highlighted[0]! > highlighted[1]! * 2);

    const exploded = await readFile(first[2]!.path);
    assert.notEqual(sha256(exploded), first[0]!.sha256);
  } finally {
    await Promise.all([
      rm(firstDirectory, { recursive: true, force: true }),
      rm(secondDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("recomposition restores cleared editable text and shapes in manifest z-order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semantic-qa-editable-"));
  try {
    const input = await fixture();
    const records = await writeQaPreviews({ ...input, outDir: directory });
    const recompositionRecord = records.find(({ kind }) => kind === "recomposition");
    assert.ok(recompositionRecord);
    const recomposition = await sharp(recompositionRecord.path)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number): number[] => {
      const offset = (y * recomposition.info.width + x) * recomposition.info.channels;
      return [...recomposition.data.subarray(offset, offset + 4)];
    };
    let textColorPixels = 0;
    for (let y = 42; y < 56; y += 1) {
      for (let x = 68; x < 92; x += 1) {
        const [red, green, blue, alpha] = pixel(x, y);
        if (red === 17 && green === 34 && blue === 51 && alpha === 255) {
          textColorPixels += 1;
        }
      }
    }

    assert.deepEqual(
      {
        shapeRestored: pixel(28, 16).slice(0, 3).join(",") === "68,136,204",
        lowerShapeStayedBehindAsset:
          pixel(15, 16).slice(0, 3).join(",") === "35,57,77",
        clearedTextRestored: textColorPixels >= 12,
        sourceGlyphRestored:
          pixel(88, 48).slice(0, 3).join(",") === "17,34,51",
      },
      {
        shapeRestored: true,
        lowerShapeStayedBehindAsset: true,
        clearedTextRestored: true,
        sourceGlyphRestored: true,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
