import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  readAnalysisPackage,
  writeAnalysisPackageV2,
  type AnalysisPackageV2,
  type CompletionArtifact,
} from "../src/analysis/package.js";
import type { OcrResult } from "../src/contracts.js";
import type { SourceCanvas } from "../src/image/source.js";
import type { SceneGraph } from "../src/scene/contracts.js";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const ocr: OcrResult = { lines: [] };
const scene: SceneGraph = {
  graphVersion: 1,
  canvas: { width: 64, height: 64 },
  nodes: [
    {
      id: "background",
      role: "background",
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      confidence: 1,
      zIndex: 0,
      label: "complete canvas",
      extractionHints: [],
    },
  ],
  relations: [],
};

type PackageFixture = {
  directory: string;
  ledger: AnalysisPackageV2;
  artifactPaths: string[];
};

async function createPackageFixture(options: {
  nestedMetadata?: unknown;
} = {}): Promise<PackageFixture> {
  const directory = await mkdtemp(join(tmpdir(), "ppt-analysis-package-"));
  const sourceBytes = Buffer.from("original-png-byte-audit-record");
  const canvas: SourceCanvas = {
    format: "png",
    width: 64,
    height: 64,
    rgba: Buffer.alloc(64 * 64 * 4, 37),
    sourceBytes,
  };
  const refinementPath = "refinements/refinement-001.json";
  const refinementBytes = Buffer.from(
    `${JSON.stringify({ reason: "occlusion", accepted: false })}\n`,
  );
  const completionPath = "completions/completion-001.png";
  const visibleMaskPath = "completions/completion-001-visible-mask.png";
  const generatedMaskPath = "completions/completion-001-generated-mask.png";
  const sourceCropPath = "completions/completion-001-source-crop.png";
  const completionBytes = Buffer.from("completed-png-bytes");
  const visibleMaskBytes = Buffer.from("visible-mask-png-bytes");
  const generatedMaskBytes = Buffer.from("generated-mask-png-bytes");
  const sourceCropBytes = await sharp(canvas.rgba, {
    raw: { width: canvas.width, height: canvas.height, channels: 4 },
  })
    .extract({ left: 8, top: 8, width: 24, height: 24 })
    .png()
    .toBuffer();
  await Promise.all([
    mkdir(join(directory, "refinements")),
    mkdir(join(directory, "completions")),
  ]);
  await Promise.all([
    writeFile(join(directory, refinementPath), refinementBytes, { mode: 0o600 }),
    writeFile(join(directory, completionPath), completionBytes, { mode: 0o600 }),
    writeFile(join(directory, visibleMaskPath), visibleMaskBytes, { mode: 0o600 }),
    writeFile(join(directory, generatedMaskPath), generatedMaskBytes, { mode: 0o600 }),
    writeFile(join(directory, sourceCropPath), sourceCropBytes, { mode: 0o600 }),
  ]).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });

  const completion: CompletionArtifact = {
    path: completionPath,
    sha256: sha256(completionBytes),
    crop: { x: 8, y: 8, width: 24, height: 24 },
    candidateId: "candidate-1",
    sourceCropPath,
    visibleMaskPath,
    generatedMaskPath,
    reviewRequired: true,
    provenance: {
      kind: "composite",
      sourceCropSha256: sha256(sourceCropBytes),
      visibleMaskSha256: sha256(visibleMaskBytes),
      generatedMaskSha256: sha256(generatedMaskBytes),
      assetSha256: sha256(completionBytes),
      modelId: "wanx2.1-imageedit",
      taskIdSha256: sha256("task-123"),
      sanitizedProviderMetadata:
        (options.nestedMetadata ?? { taskStatus: "SUCCEEDED" }) as never,
    },
  };
  const refinements = [
    {
      path: refinementPath,
      sha256: sha256(refinementBytes),
      crop: { x: 4, y: 4, width: 32, height: 32 },
    },
  ];
  const ledger: AnalysisPackageV2 = {
    analysisVersion: 2,
    mode: "replay",
    recorded: true,
    canvas: { width: canvas.width, height: canvas.height },
    source: {
      path: "source.rgba",
      sha256: sha256(canvas.rgba),
      originalSha256: sha256(sourceBytes),
      format: canvas.format,
    },
    ocr: {
      path: "ocr.json",
      sha256: sha256(`${JSON.stringify(ocr, null, 2)}\n`),
    },
    scene: {
      path: "scene-graph.json",
      sha256: sha256(`${JSON.stringify(scene, null, 2)}\n`),
    },
    refinements,
    completions: [completion],
    requests: { ocr: 1, fullVision: 1, regionalVision: 1, completion: 1 },
    models: {
      ocr: "qwen3.5-ocr",
      fullVision: "qwen3-vl-plus",
      regionalVision: "qwen3-vl-plus",
      completion: "wanx2.1-imageedit",
    },
    durationsMs: {
      ocr: 1,
      fullVision: 2,
      regionalVision: 3,
      completion: 4,
      analyze: 10,
    },
    warnings: [],
  };

  await writeAnalysisPackageV2({
    directory,
    canvas,
    ocr,
    scene,
    refinements,
    completions: [completion],
    ledger,
  });

  return {
    directory,
    ledger,
    artifactPaths: [
      "source.rgba",
      "ocr.json",
      "scene-graph.json",
      refinementPath,
      completionPath,
      visibleMaskPath,
      generatedMaskPath,
      sourceCropPath,
    ],
  };
}

test("round-trips a complete self-contained v2 package with private JSON files", async () => {
  const fixture = await createPackageFixture();
  try {
    const parsed = await readAnalysisPackage(fixture.directory);
    assert.equal(parsed.analysisVersion, 2);
    assert.deepEqual(parsed.canvas, { width: 64, height: 64 });
    assert.equal(parsed.source.format, "png");
    assert.equal(
      await readFile(join(fixture.directory, "source.rgba")).then(sha256),
      parsed.source.sha256,
    );
    assert.equal(parsed.completions[0]?.reviewRequired, true);
    if (process.platform !== "win32") {
      for (const name of ["analysis-ledger.json", "ocr.json", "scene-graph.json"]) {
        assert.equal((await stat(join(fixture.directory, name))).mode & 0o777, 0o600);
      }
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a hash mismatch in every referenced v2 artifact", async () => {
  const fixture = await createPackageFixture();
  try {
    for (const relativePath of fixture.artifactPaths) {
      const path = join(fixture.directory, relativePath);
      const original = await readFile(path);
      await writeFile(path, Buffer.concat([original, Buffer.from("tampered")]), {
        mode: 0o600,
      });
      await assert.rejects(
        readAnalysisPackage(fixture.directory),
        new RegExp(`hash mismatch.*${relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
      );
      await writeFile(path, original, { mode: 0o600 });
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects missing and symlinked v2 artifacts", async () => {
  const missing = await createPackageFixture();
  const symlinked = await createPackageFixture();
  try {
    await rm(join(missing.directory, missing.artifactPaths.at(-1)!));
    await assert.rejects(readAnalysisPackage(missing.directory), /missing|ENOENT/i);

    const artifact = join(symlinked.directory, symlinked.artifactPaths[3]!);
    const external = join(symlinked.directory, "external.json");
    await writeFile(external, await readFile(artifact), { mode: 0o600 });
    await rm(artifact);
    await symlink(external, artifact);
    await assert.rejects(
      readAnalysisPackage(symlinked.directory),
      /symbolic link|regular file/i,
    );
  } finally {
    await Promise.all([
      rm(missing.directory, { recursive: true, force: true }),
      rm(symlinked.directory, { recursive: true, force: true }),
    ]);
  }
});

test("rejects path escape and unknown ledger fields", async () => {
  const escaped = await createPackageFixture();
  const strict = await createPackageFixture();
  try {
    const outside = join(escaped.directory, "..", "outside-refinement.json");
    const outsideBytes = Buffer.from("outside");
    await writeFile(outside, outsideBytes, { mode: 0o600 });
    const escapedLedger = JSON.parse(
      await readFile(join(escaped.directory, "analysis-ledger.json"), "utf8"),
    ) as AnalysisPackageV2;
    escapedLedger.refinements[0] = {
      ...escapedLedger.refinements[0]!,
      path: "../outside-refinement.json",
      sha256: sha256(outsideBytes),
    };
    await writeFile(
      join(escaped.directory, "analysis-ledger.json"),
      `${JSON.stringify(escapedLedger, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(readAnalysisPackage(escaped.directory), /safe relative path|path escape/i);

    const strictLedger = JSON.parse(
      await readFile(join(strict.directory, "analysis-ledger.json"), "utf8"),
    ) as Record<string, unknown>;
    strictLedger.unexpected = true;
    await writeFile(
      join(strict.directory, "analysis-ledger.json"),
      `${JSON.stringify(strictLedger, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(readAnalysisPackage(strict.directory), /unrecognized|unexpected|invalid/i);
  } finally {
    await Promise.all([
      rm(escaped.directory, { recursive: true, force: true }),
      rm(strict.directory, { recursive: true, force: true }),
    ]);
  }
});

test("rejects a completion asset hash that disagrees with its provenance", async () => {
  const fixture = await createPackageFixture();
  try {
    const ledger = JSON.parse(
      await readFile(join(fixture.directory, "analysis-ledger.json"), "utf8"),
    ) as AnalysisPackageV2;
    const completion = ledger.completions[0]!;
    if (completion.provenance.kind !== "composite") {
      throw new Error("fixture requires composite provenance");
    }
    completion.provenance.assetSha256 = sha256("different-asset");
    await writeFile(
      join(fixture.directory, "analysis-ledger.json"),
      `${JSON.stringify(ledger, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      readAnalysisPackage(fixture.directory),
      /completion.*provenance|provenance.*hash/i,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects missing or falsely attributed completion source crops", async () => {
  const bogusHash = await createPackageFixture();
  const missingPath = await createPackageFixture();
  const missingCrop = await createPackageFixture();
  const wrongDimensions = await createPackageFixture();
  const wrongPixels = await createPackageFixture();
  try {
    const bogusLedger = JSON.parse(
      await readFile(join(bogusHash.directory, "analysis-ledger.json"), "utf8"),
    ) as AnalysisPackageV2;
    const bogusCompletion = bogusLedger.completions[0]!;
    assert.equal(bogusCompletion.provenance.kind, "composite");
    bogusCompletion.provenance.sourceCropSha256 = sha256("not-the-source-crop");
    await writeFile(
      join(bogusHash.directory, "analysis-ledger.json"),
      `${JSON.stringify(bogusLedger, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      readAnalysisPackage(bogusHash.directory),
      /source.crop|hash mismatch/i,
    );

    for (const [fixture, field] of [
      [missingPath, "sourceCropPath"],
      [missingCrop, "crop"],
    ] as const) {
      const ledger = JSON.parse(
        await readFile(join(fixture.directory, "analysis-ledger.json"), "utf8"),
      ) as AnalysisPackageV2;
      delete (ledger.completions[0] as unknown as Record<string, unknown>)[field];
      await writeFile(
        join(fixture.directory, "analysis-ledger.json"),
        `${JSON.stringify(ledger, null, 2)}\n`,
        { mode: 0o600 },
      );
      await assert.rejects(
        readAnalysisPackage(fixture.directory),
        new RegExp(field === "crop" ? "crop|required|invalid" : "sourceCropPath|invalid", "i"),
      );
    }

    const dimensionLedger = JSON.parse(
      await readFile(join(wrongDimensions.directory, "analysis-ledger.json"), "utf8"),
    ) as AnalysisPackageV2;
    const dimensionCompletion = dimensionLedger.completions[0]!;
    assert.equal(dimensionCompletion.provenance.kind, "composite");
    const wrongCrop = await sharp({
      create: {
        width: 12,
        height: 12,
        channels: 4,
        background: "#25364a",
      },
    }).png().toBuffer();
    await writeFile(
      join(wrongDimensions.directory, dimensionCompletion.sourceCropPath),
      wrongCrop,
      { mode: 0o600 },
    );
    dimensionCompletion.provenance.sourceCropSha256 = sha256(wrongCrop);
    await writeFile(
      join(wrongDimensions.directory, "analysis-ledger.json"),
      `${JSON.stringify(dimensionLedger, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      readAnalysisPackage(wrongDimensions.directory),
      /source.crop.*dimensions|dimensions.*source.crop/i,
    );

    const pixelLedger = JSON.parse(
      await readFile(join(wrongPixels.directory, "analysis-ledger.json"), "utf8"),
    ) as AnalysisPackageV2;
    const pixelCompletion = pixelLedger.completions[0]!;
    assert.equal(pixelCompletion.provenance.kind, "composite");
    const falseCrop = await sharp({
      create: {
        width: 24,
        height: 24,
        channels: 4,
        background: "#ff00cc",
      },
    }).png().toBuffer();
    await writeFile(
      join(wrongPixels.directory, pixelCompletion.sourceCropPath),
      falseCrop,
      { mode: 0o600 },
    );
    pixelCompletion.provenance.sourceCropSha256 = sha256(falseCrop);
    await writeFile(
      join(wrongPixels.directory, "analysis-ledger.json"),
      `${JSON.stringify(pixelLedger, null, 2)}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      readAnalysisPackage(wrongPixels.directory),
      /source.crop.*canonical|canonical.*source.crop|source.crop.*pixels/i,
    );
  } finally {
    await Promise.all(
      [bogusHash, missingPath, missingCrop, wrongDimensions, wrongPixels].map(
        (fixture) => rm(fixture.directory, { recursive: true, force: true }),
      ),
    );
  }
});

test("recursively sanitizes secret-like completion metadata before publication", async () => {
  const configuredCanary = "sk-secret-like-canary-123456789";
  const bearerCanary = "opaque-bearer-canary-987654321";
  const signatureCanary = "signed-query-canary-555";
  const rawTaskId = "wanx-task-opaque-canary-246813579";
  const opaqueMetadataCanary = "QW5hbHlzaXNPcGFxdWVUcmFjaW5nVG9rZW4xMjM0NTY=";
  const fixture = await createPackageFixture({
    nestedMetadata: {
      authorization: `Bearer ${bearerCanary}`,
      safe: {
        message: configuredCanary,
        url: `https://bucket.example/object?X-OSS-Signature=${signatureCanary}&Expires=99`,
        status: "SUCCEEDED",
        requestId: rawTaskId,
        opaqueReference: opaqueMetadataCanary,
      },
    },
  });
  try {
    const text = await readFile(join(fixture.directory, "analysis-ledger.json"), "utf8");
    const parsed = await readAnalysisPackage(fixture.directory);
    assert.equal(parsed.analysisVersion, 2);
    assert.doesNotMatch(
      text,
      /secret-like-canary|opaque-bearer-canary|signed-query-canary|authorization|X-OSS-Signature|Expires=99/i,
    );
    assert.doesNotMatch(text, /wanx-task-opaque-canary|QW5hbHlzaXNPcGFxdWU/);
    assert.match(text, new RegExp(sha256("task-123")));
    assert.doesNotMatch(text, /"taskId"/);
    assert.match(text, /SUCCEEDED/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reads a v1 analysis directory without mutating or upgrading it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-analysis-v1-"));
  const ocrBytes = Buffer.from(`${JSON.stringify({ lines: [] }, null, 2)}\n`);
  const visionBytes = Buffer.from(`${JSON.stringify({ elements: [] }, null, 2)}\n`);
  const ledger = {
    analysisVersion: 1,
    mode: "replay",
    recorded: false,
    models: { ocr: "legacy-ocr", vision: "legacy-vision", edit: "legacy-edit" },
    durationsMs: { ocr: 1, vision: 2, analyze: 3 },
    warnings: [],
    hashes: {
      sourceImage: sha256("external-source"),
      ocr: sha256(ocrBytes),
      vision: sha256(visionBytes),
    },
    outputs: { ocr: "ocr.json", vision: "vision.json" },
    legacyExtension: { harmless: true },
  };
  try {
    await Promise.all([
      writeFile(join(directory, "ocr.json"), ocrBytes, { mode: 0o600 }),
      writeFile(join(directory, "vision.json"), visionBytes, { mode: 0o600 }),
      writeFile(
        join(directory, "analysis-ledger.json"),
        `${JSON.stringify(ledger, null, 2)}\n`,
        { mode: 0o600 },
      ),
    ]);
    const before = (await readdir(directory)).sort();
    const parsed = await readAnalysisPackage(directory);
    assert.equal(parsed.analysisVersion, 1);
    assert.deepEqual((await readdir(directory)).sort(), before);
    assert.equal((await lstat(join(directory, "analysis-ledger.json"))).isFile(), true);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
