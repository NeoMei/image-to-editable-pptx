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
  const manifest: SlideManifestV2 = {
    manifestVersion: 2,
    canvas: { width, height },
    warnings: [],
    elements: assets.map((asset, index) => ({
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
    })),
  };
  const rgba = await sharp(background).ensureAlpha().raw().toBuffer();
  return {
    canvas: { format: "png", width, height, rgba, sourceBytes: background },
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
