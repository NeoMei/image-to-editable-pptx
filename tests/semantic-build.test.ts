import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import type { BBox, OcrResult } from "../src/contracts.js";
import {
  buildSemanticLayers,
  repairCommittedUnion,
} from "../src/fidelity/build.js";
import * as fidelityBuild from "../src/fidelity/build.js";
import {
  chooseSemanticMask,
  deriveSemanticMasks,
} from "../src/image/semantic-mask.js";
import type { SourceCanvas } from "../src/image/source.js";
import { buildTightTextMask } from "../src/image/text-mask.js";
import type { CompletedCandidate } from "../src/occlusion/contracts.js";
import type {
  SceneGraph,
  SceneNode,
  SceneRelation,
} from "../src/scene/contracts.js";
import { planSemanticLayers, type SemanticCandidate } from "../src/scene/plan.js";

type Rgba = readonly [number, number, number, number];

const WIDTH = 320;
const HEIGHT = 200;
const BACKGROUND: Rgba = [247, 243, 233, 255];
const GOOD_REAR: BBox = { x: 140, y: 20, width: 40, height: 36 };
const GOOD_FRONT: BBox = { x: 154, y: 28, width: 12, height: 20 };
const BAD_REAR: BBox = { x: 200, y: 20, width: 40, height: 36 };
const BAD_FRONT: BBox = { x: 214, y: 28, width: 12, height: 20 };

function sha256(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function fillCanvas(): SourceCanvas {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    rgba.set(BACKGROUND, index * 4);
  }
  return {
    format: "png",
    width: WIDTH,
    height: HEIGHT,
    rgba,
    sourceBytes: Buffer.alloc(0),
  };
}

function paintRect(canvas: SourceCanvas, bbox: BBox, color: Rgba): void {
  for (let y = Math.floor(bbox.y); y < Math.ceil(bbox.y + bbox.height); y += 1) {
    for (let x = Math.floor(bbox.x); x < Math.ceil(bbox.x + bbox.width); x += 1) {
      canvas.rgba.set(color, (y * canvas.width + x) * 4);
    }
  }
}

function paintGlyphs(canvas: SourceCanvas, bbox: BBox): void {
  for (let y = bbox.y + 2; y < bbox.y + bbox.height - 2; y += 1) {
    for (const x of [bbox.x + 6, bbox.x + 14, bbox.x + 23, bbox.x + 31]) {
      if (x >= bbox.x + bbox.width) continue;
      canvas.rgba.set([20, 24, 28, 255], (y * canvas.width + x) * 4);
    }
  }
}

function normalized(bbox: BBox): SceneNode["bbox"] {
  return {
    x: bbox.x / WIDTH,
    y: bbox.y / HEIGHT,
    width: bbox.width / WIDTH,
    height: bbox.height / HEIGHT,
  };
}

function node(
  id: string,
  role: SceneNode["role"],
  bbox: BBox,
  zIndex: number,
): SceneNode {
  return {
    id,
    role,
    bbox: normalized(bbox),
    confidence: 0.98,
    zIndex,
    label: `audit-${id}`,
    extractionHints: [],
  };
}

function relation(
  id: string,
  kind: SceneRelation["kind"],
  from: string,
  to: string,
): SceneRelation {
  return { id, kind, from, to, confidence: 0.98 };
}

function line(text: string, bbox: BBox): OcrResult["lines"][number] {
  return {
    text,
    bbox,
    quad: [
      { x: bbox.x, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
      { x: bbox.x, y: bbox.y + bbox.height },
    ],
  };
}

async function semanticFixture(): Promise<{
  source: SourceCanvas;
  ocr: OcrResult;
  graph: SceneGraph;
}> {
  const source = fillCanvas();
  const acceptedBacking = { x: 90, y: 120, width: 80, height: 50 };
  const acceptedText = { x: 110, y: 136, width: 40, height: 16 };
  const rejectedBacking = { x: 0, y: 120, width: 72, height: 50 };
  const rejectedText = { x: 16, y: 136, width: 36, height: 16 };
  paintRect(source, acceptedBacking, [88, 96, 102, 255]);
  paintGlyphs(source, acceptedText);
  paintRect(source, rejectedBacking, [238, 235, 225, 255]);
  paintGlyphs(source, rejectedText);
  paintRect(source, { x: 20, y: 20, width: 20, height: 24 }, [35, 57, 77, 255]);
  paintRect(source, { x: 60, y: 20, width: 16, height: 24 }, [52, 98, 135, 255]);
  paintRect(source, { x: 96, y: 20, width: 16, height: 24 }, [52, 98, 135, 255]);
  paintRect(source, { x: 76, y: 31, width: 20, height: 2 }, [52, 98, 135, 255]);
  paintRect(source, GOOD_REAR, [43, 109, 168, 255]);
  paintRect(source, GOOD_FRONT, [230, 93, 22, 255]);
  paintRect(source, BAD_REAR, [58, 142, 92, 255]);
  paintRect(source, BAD_FRONT, [133, 76, 176, 255]);
  paintRect(source, { x: 260, y: 120, width: 16, height: 20 }, [185, 58, 64, 255]);
  paintRect(source, { x: 282, y: 120, width: 16, height: 20 }, [204, 142, 42, 255]);
  source.sourceBytes = await sharp(source.rgba, {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 },
  }).png().toBuffer();

  const ocr = {
    lines: [line("Accepted backing", acceptedText), line("Fallback text", rejectedText)],
  };
  const graph: SceneGraph = {
    graphVersion: 1,
    canvas: { width: WIDTH, height: HEIGHT },
    nodes: [
      node("background", "background", { x: 0, y: 0, width: WIDTH, height: HEIGHT }, 0),
      node("independent", "foreground-object", { x: 20, y: 20, width: 20, height: 24 }, 1),
      node("compound", "compound-group", { x: 60, y: 20, width: 52, height: 24 }, 2),
      node("compound-left", "foreground-object", { x: 60, y: 20, width: 16, height: 24 }, 2),
      node("compound-right", "foreground-object", { x: 96, y: 20, width: 16, height: 24 }, 2),
      node("compound-link", "connector", { x: 76, y: 31, width: 20, height: 2 }, 2),
      node("good-rear", "foreground-object", GOOD_REAR, 3),
      node("good-front", "foreground-object", GOOD_FRONT, 4),
      node("bad-rear", "foreground-object", BAD_REAR, 5),
      node("bad-front", "foreground-object", BAD_FRONT, 6),
      node("accepted-backing", "text-backing", acceptedBacking, 7),
      node("accepted-scene-text", "text", acceptedText, 8),
      node("rejected-backing", "text-backing", rejectedBacking, 9),
      node("rejected-scene-text", "text", rejectedText, 10),
      node("cycle-a", "foreground-object", { x: 260, y: 120, width: 16, height: 20 }, 11),
      node("cycle-b", "foreground-object", { x: 282, y: 120, width: 16, height: 20 }, 12),
    ],
    relations: [
      relation("compound-left-group", "belongs-to", "compound-left", "compound"),
      relation("compound-right-group", "belongs-to", "compound-right", "compound"),
      relation("compound-connected", "connected-to", "compound-left", "compound-link"),
      relation("good-occlusion", "occludes", "good-front", "good-rear"),
      relation("bad-occlusion", "occludes", "bad-front", "bad-rear"),
      relation("accepted-carries", "carries-text", "accepted-backing", "accepted-scene-text"),
      relation("rejected-carries", "carries-text", "rejected-backing", "rejected-scene-text"),
      relation("cycle-a-front", "in-front-of", "cycle-a", "cycle-b"),
      relation("cycle-b-front", "in-front-of", "cycle-b", "cycle-a"),
    ],
  };
  return { source, ocr, graph };
}

async function emptyMask(): Promise<Buffer> {
  return sharp(Buffer.alloc(WIDTH * HEIGHT), {
    raw: { width: WIDTH, height: HEIGHT, channels: 1 },
  }).png().toBuffer();
}

async function completionFor(
  source: SourceCanvas,
  candidate: SemanticCandidate,
  rear: BBox,
  occluder: BBox,
  color: Rgba,
  exposedError = false,
): Promise<CompletedCandidate> {
  const selected = chooseSemanticMask(
    await deriveSemanticMasks(source, candidate),
    await emptyMask(),
  );
  assert.ok(selected);
  const width = Math.ceil(selected.bbox.width);
  const height = Math.ceil(selected.bbox.height);
  const rgba = Buffer.alloc(width * height * 4);
  const visible = Buffer.alloc(width * height);
  const generated = Buffer.alloc(width * height);
  const exposedX = rear.x + 4;
  const exposedY = rear.y + 4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const canvasX = Math.floor(selected.bbox.x) + x;
      const canvasY = Math.floor(selected.bbox.y) + y;
      const insideRear =
        canvasX >= rear.x && canvasX < rear.x + rear.width &&
        canvasY >= rear.y && canvasY < rear.y + rear.height;
      if (!insideRear) continue;
      const insideOccluder =
        canvasX >= occluder.x && canvasX < occluder.x + occluder.width &&
        canvasY >= occluder.y && canvasY < occluder.y + occluder.height;
      const isExposedError = exposedError && canvasX === exposedX && canvasY === exposedY;
      const index = y * width + x;
      rgba.set(isExposedError ? [245, 245, 245, 255] : color, index * 4);
      if (insideOccluder || isExposedError) generated[index] = 255;
      else visible[index] = 255;
    }
  }
  const [image, visibleMask, generatedMask, sourceCrop] = await Promise.all([
    sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    sharp(visible, { raw: { width, height, channels: 1 } }).png().toBuffer(),
    sharp(generated, { raw: { width, height, channels: 1 } }).png().toBuffer(),
    sharp(source.rgba, {
      raw: { width: source.width, height: source.height, channels: 4 },
    }).extract({
      left: Math.floor(selected.bbox.x),
      top: Math.floor(selected.bbox.y),
      width,
      height,
    }).png().toBuffer(),
  ]);
  return {
    image,
    visibleMask,
    generatedMask,
    reviewRequired: true,
    provenance: {
      kind: "composite",
      sourceCropSha256: sha256(sourceCrop),
      visibleMaskSha256: sha256(visibleMask),
      generatedMaskSha256: sha256(generatedMask),
      assetSha256: sha256(image),
      modelId: "fixture-completion-model",
      taskIdSha256: sha256(Buffer.from(candidate.id)),
      sanitizedProviderMetadata: { purpose: "semantic-build-regression" },
    },
  };
}

async function maskPixels(mask: Buffer): Promise<Buffer> {
  return sharp(mask).removeAlpha().greyscale().raw().toBuffer();
}

async function rgbaPixels(image: Buffer): Promise<Buffer> {
  return sharp(image).ensureAlpha().raw().toBuffer();
}

const rejectedRepairMetrics = {
  maskedPixels: 1,
  outsideMaskChangedPixels: 0,
  ringSamples: 16,
  ringChannelMad: 0,
  filledPixelDistanceP95: 0,
};

test("atomically builds graph-ordered semantic layers and rolls back one exposed completion", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  assert.equal(plan.candidates.some(({ id }) => id === "cycle-a" || id === "cycle-b"), false);
  const byId = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const completions = new Map<string, CompletedCandidate>([
    [
      "good-rear",
      await completionFor(
        fixture.source,
        byId.get("good-rear")!,
        GOOD_REAR,
        GOOD_FRONT,
        [43, 109, 168, 255],
      ),
    ],
    [
      "bad-rear",
      await completionFor(
        fixture.source,
        byId.get("bad-rear")!,
        BAD_REAR,
        BAD_FRONT,
        [58, 142, 92, 255],
        true,
      ),
    ],
  ]);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-build-"));
  try {
    const result = await buildSemanticLayers({
      source: fixture.source,
      ocr: fixture.ocr,
      graph: fixture.graph,
      plan,
      completions,
      workDir,
    });

    assert.equal(result.manifest.manifestVersion, 2);
    assert.equal(result.recomposition.accepted, true);
    assert.equal(result.manifest.elements.some(({ id }) => id === "cycle-a"), false);
    assert.equal(result.manifest.elements.some(({ id }) => id === "cycle-b"), false);
    assert.equal(result.manifest.elements.some(({ id }) => id === "rejected-backing"), false);
    assert.equal(result.manifest.elements.some(({ id }) => id === "bad-rear"), false);
    for (const id of [
      "independent",
      "compound",
      "good-rear",
      "good-front",
      "bad-front",
      "accepted-backing",
      "ocr-1",
      "ocr-2",
    ]) {
      assert.equal(result.manifest.elements.some((element) => element.id === id), true, id);
    }

    const backingIndex = result.manifest.elements.findIndex(({ id }) => id === "accepted-backing");
    const carriedTextIndex = result.manifest.elements.findIndex(({ id }) => id === "ocr-1");
    assert.ok(backingIndex >= 0 && backingIndex < carriedTextIndex);
    const backing = result.manifest.elements[backingIndex]!;
    assert.equal(backing.kind, "asset");
    if (backing.kind === "asset") {
      assert.deepEqual(backing.relations.map(({ id }) => id), ["accepted-carries"]);
    }

    const generated = result.manifest.elements.find(({ id }) => id === "good-rear");
    assert.equal(generated?.kind, "asset");
    if (generated?.kind === "asset") {
      assert.equal(generated.reviewRequired, true);
      assert.deepEqual(generated.provenance, completions.get("good-rear")!.provenance);
    }
    const visible = result.manifest.elements.find(({ id }) => id === "independent");
    assert.equal(visible?.kind, "asset");
    if (visible?.kind === "asset") {
      assert.equal(visible.reviewRequired, false);
      assert.equal(visible.provenance.kind, "source-visible");
    }

    const badDecision = result.decisions.find(({ candidateId }) => candidateId === "bad-rear");
    assert.equal(badDecision?.decision, "kept_in_background");
    assert.equal(badDecision?.reason, "recomposition_mismatch");
    const rejectedBackingDecision = result.decisions.find(
      ({ candidateId }) => candidateId === "rejected-backing",
    );
    assert.equal(rejectedBackingDecision?.decision, "kept_in_background");

    const combined = await maskPixels(result.combinedMask);
    assert.ok(combined[30 * WIDTH + 30]! >= 128);
    assert.ok(combined[31 * WIDTH + 84]! >= 128);
    assert.ok(combined[130 * WIDTH + 120]! >= 128);
    assert.equal(combined[128 * WIDTH + 30], 0);
    assert.equal(combined[124 * WIDTH + 264], 0);
    assert.equal(combined[24 * WIDTH + 204], 0);

    const [before, after] = await Promise.all([
      Promise.resolve(fixture.source.rgba),
      rgbaPixels(result.background),
    ]);
    for (const [x, y] of [[30, 128], [264, 124], [204, 24]] as const) {
      const offset = (y * WIDTH + x) * 4;
      assert.deepEqual(after.subarray(offset, offset + 4), before.subarray(offset, offset + 4));
    }
    for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
      if (combined[index]! >= 128) continue;
      assert.deepEqual(
        after.subarray(index * 4, index * 4 + 4),
        before.subarray(index * 4, index * 4 + 4),
      );
    }

    assert.deepEqual(
      result.manifest.elements.map(({ zIndex }) => zIndex),
      [...result.manifest.elements.map(({ zIndex }) => zIndex)].sort((left, right) => left - right),
    );
    for (const asset of result.acceptedAssets) {
      assert.deepEqual(await readFile(join(workDir, asset.assetPath)), asset.image);
    }
    const publication = await fidelityBuild.readSemanticAssetPublication(
      join(workDir, "assets"),
    );
    assert.deepEqual(
      publication.inventory.map(({ path, sha256: hash }) => ({ path, hash })),
      result.acceptedAssets.map((asset) => ({
        path: asset.assetPath,
        hash: sha256(asset.image),
      })),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("keeps a text candidate in background when its tight mask cannot be built", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const byId = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  const completions = new Map<string, CompletedCandidate>([
    [
      "good-rear",
      await completionFor(
        fixture.source,
        byId.get("good-rear")!,
        GOOD_REAR,
        GOOD_FRONT,
        [43, 109, 168, 255],
      ),
    ],
    [
      "bad-rear",
      await completionFor(
        fixture.source,
        byId.get("bad-rear")!,
        BAD_REAR,
        BAD_FRONT,
        [58, 142, 92, 255],
      ),
    ],
  ]);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-build-text-mask-fallback-"));
  try {
    const result = await buildSemanticLayers(
      {
        source: fixture.source,
        ocr: fixture.ocr,
        graph: fixture.graph,
        plan,
        completions,
        workDir,
      },
      {
        buildTextMask: async (source, element, options) => {
          if (element.text === "Accepted backing") {
            throw new Error("injected tight-text-mask failure");
          }
          return buildTightTextMask(source, element, options);
        },
      },
    );

    const decisions = new Map(
      result.decisions.map((decision) => [decision.candidateId, decision]),
    );
    const failedText = decisions.get("ocr-1");
    assert.equal(failedText?.decision, "kept_in_background");
    assert.equal(failedText?.reason, "text_mask_unavailable");
    assert.equal(failedText?.repairMethod, "none");
    assert.equal(failedText?.extraction, "none");
    const survivingText = decisions.get("ocr-2");
    assert.equal(survivingText?.decision, "accepted");

    const elements = new Map(
      result.manifest.elements.map((element) => [element.id, element]),
    );
    assert.equal(elements.has("ocr-1"), false);
    assert.equal(elements.get("ocr-2")?.kind, "text");
    assert.equal(result.recomposition.accepted, true);

    const combined = await maskPixels(result.combinedMask);
    assert.equal(combined[138 * WIDTH + 116], 0);
    assert.ok(combined[138 * WIDTH + 22]! >= 128);

    const [before, after] = await Promise.all([
      Promise.resolve(fixture.source.rgba),
      rgbaPixels(result.background),
    ]);
    const glyphOffset = (138 * WIDTH + 116) * 4;
    assert.deepEqual(
      after.subarray(glyphOffset, glyphOffset + 4),
      before.subarray(glyphOffset, glyphOffset + 4),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("rejects an empty supplied plan before publishing files", async () => {
  const fixture = await semanticFixture();
  const canonical = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-empty-plan-"));
  await writeFile(join(workDir, "keep.txt"), "unrelated");
  try {
    await assert.rejects(
      buildSemanticLayers({
        source: fixture.source,
        ocr: fixture.ocr,
        graph: fixture.graph,
        plan: { ...canonical, text: [], candidates: [] },
        completions: new Map(),
        workDir,
      }),
      /canonical semantic plan/,
    );
    assert.deepEqual(await readdir(workDir), ["keep.txt"]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("rejects a stale supplied plan that reintroduces a graph cycle", async () => {
  const fixture = await semanticFixture();
  const canonical = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-stale-plan-"));
  const staleCandidate: SemanticCandidate = {
    id: "cycle-a",
    kind: "foreground-object",
    nodeIds: ["cycle-a"],
    bbox: { x: 260, y: 120, width: 16, height: 20 },
    zOrder: canonical.candidates.length,
    relations: ["cycle-a-front", "cycle-b-front"],
    carriedTextIds: [],
  };
  try {
    await assert.rejects(
      buildSemanticLayers({
        source: fixture.source,
        ocr: fixture.ocr,
        graph: fixture.graph,
        plan: {
          ...canonical,
          candidates: [...canonical.candidates, staleCandidate],
        },
        completions: new Map(),
        workDir,
      }),
      /canonical semantic plan/,
    );
    assert.deepEqual(await readdir(workDir), []);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("rolls back only the candidate identified by committed-union repair", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-repair-owner-"));
  let repairCalls = 0;
  try {
    const result = await buildSemanticLayers(
      {
        source: fixture.source,
        ocr: fixture.ocr,
        graph: fixture.graph,
        plan,
        completions: new Map(),
        workDir,
      },
      {
        repairCommittedUnion: async (transaction) => {
          repairCalls += 1;
          if (repairCalls === 1) {
            return {
              image: transaction.source,
              accepted: false,
              metrics: rejectedRepairMetrics,
              reason: "surface_variance_too_high",
              attribution: "deterministic",
              failingCandidateIds: ["independent"],
            };
          }
          return repairCommittedUnion(transaction);
        },
      },
    );

    assert.equal(repairCalls, 2);
    assert.equal(result.manifest.elements.some(({ id }) => id === "independent"), false);
    assert.equal(result.manifest.elements.some(({ id }) => id === "compound"), true);
    assert.equal(
      result.decisions.find(({ candidateId }) => candidateId === "independent")?.decision,
      "kept_in_background",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("passes the complete committed mask through one union-repair transaction", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-union-repair-"));
  const receivedMasks: Buffer[] = [];
  try {
    const result = await buildSemanticLayers(
      {
        source: fixture.source,
        ocr: fixture.ocr,
        graph: fixture.graph,
        plan,
        completions: new Map(),
        workDir,
      },
      {
        repairCommittedUnion: async (transaction) => {
          receivedMasks.push(transaction.unionMask);
          return repairCommittedUnion(transaction);
        },
      },
    );

    assert.equal(receivedMasks.length, 1);
    assert.deepEqual(
      await maskPixels(receivedMasks[0]!),
      await maskPixels(result.combinedMask),
    );
    const pixels = await maskPixels(receivedMasks[0]!);
    assert.ok(pixels[30 * WIDTH + 30]! >= 128, "foreground mask is in full union");
    assert.ok(pixels[140 * WIDTH + 116]! >= 128, "required OCR mask is in full union");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("removes owned staging when the second asset write fails", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-write-failure-"));
  await writeFile(join(workDir, "keep.txt"), "unrelated");
  let writes = 0;
  try {
    await assert.rejects(
      buildSemanticLayers(
        {
          source: fixture.source,
          ocr: fixture.ocr,
          graph: fixture.graph,
          plan,
          completions: new Map(),
          workDir,
        },
        {
          writeAsset: async (path, image) => {
            writes += 1;
            if (writes === 2) throw new Error("injected second asset write failure");
            await writeFile(path, image);
          },
        },
      ),
      /injected second asset write failure/,
    );
    assert.equal(writes, 2);
    assert.deepEqual(await readdir(workDir), ["keep.txt"]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing assets directory", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-existing-assets-"));
  await mkdir(join(workDir, "assets"));
  await writeFile(join(workDir, "assets", "foreign.txt"), "unrelated");
  try {
    await assert.rejects(
      buildSemanticLayers({
        source: fixture.source,
        ocr: fixture.ocr,
        graph: fixture.graph,
        plan,
        completions: new Map(),
        workDir,
      }),
      /assets target already exists/,
    );
    assert.equal(await readFile(join(workDir, "assets", "foreign.txt"), "utf8"), "unrelated");
    assert.deepEqual(await readdir(join(workDir, "assets")), ["foreign.txt"]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("refuses an assets symlink without touching its target", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-assets-symlink-"));
  const externalDir = await mkdtemp(join(tmpdir(), "semantic-assets-external-"));
  await writeFile(join(externalDir, "foreign.txt"), "unrelated");
  await symlink(externalDir, join(workDir, "assets"));
  try {
    await assert.rejects(
      buildSemanticLayers({
        source: fixture.source,
        ocr: fixture.ocr,
        graph: fixture.graph,
        plan,
        completions: new Map(),
        workDir,
      }),
      /assets target already exists/,
    );
    assert.equal((await lstat(join(workDir, "assets"))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(externalDir), ["foreign.txt"]);
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("fails closed when a competitor claims assets after preflight", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-assets-claim-race-"));
  const assetsDir = join(workDir, "assets");
  let competitorRan = false;
  try {
    await assert.rejects(
      buildSemanticLayers(
        {
          source: fixture.source,
          ocr: fixture.ocr,
          graph: fixture.graph,
          plan,
          completions: new Map(),
          workDir,
        },
        {
          createAssetsDirectory: async (path: string) => {
            competitorRan = true;
            await mkdir(path);
            await writeFile(join(path, "competitor.txt"), "foreign");
            await mkdir(path);
          },
        },
      ),
      /assets target already exists|EEXIST/,
    );
    assert.equal(competitorRan, true);
    assert.deepEqual(await readdir(assetsDir), ["competitor.txt"]);
    assert.equal(await readFile(join(assetsDir, "competitor.txt"), "utf8"), "foreign");
    assert.equal(
      (await readdir(assetsDir)).includes(".semantic-assets-complete.json"),
      false,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("retains a foreign file injected during publication without completing", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-assets-contamination-"));
  const assetsDir = join(workDir, "assets");
  let publishedFiles = 0;
  try {
    await assert.rejects(
      buildSemanticLayers(
        {
          source: fixture.source,
          ocr: fixture.ocr,
          graph: fixture.graph,
          plan,
          completions: new Map(),
          workDir,
        },
        {
          publishAssetNoReplace: async (
            stagedPath: string,
            finalPath: string,
          ) => {
            await link(stagedPath, finalPath);
            publishedFiles += 1;
            if (publishedFiles === 1) {
              await writeFile(join(assetsDir, "competitor.txt"), "foreign", {
                flag: "wx",
              });
            }
          },
        },
      ),
      /unexpected entry|contaminated/,
    );
    assert.ok(publishedFiles >= 1);
    const evidence = await readdir(assetsDir);
    assert.ok(evidence.includes("competitor.txt"));
    assert.ok(evidence.includes(".semantic-assets-owner.json"));
    assert.ok(evidence.some((name) => name.endsWith(".png")));
    assert.equal(evidence.includes(".semantic-assets-complete.json"), false);
    assert.equal(await readFile(join(assetsDir, "competitor.txt"), "utf8"), "foreign");
    assert.deepEqual(await readdir(workDir), ["assets"]);
    await assert.rejects(
      fidelityBuild.readSemanticAssetPublication(assetsDir),
      /completion|inventory|unexpected/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("rejects a completion marker written into a replacement directory", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-assets-dir-replacement-"));
  const assetsDir = join(workDir, "assets");
  const displacedDir = join(workDir, "claimed-assets-evidence");
  let replacementCreated = false;
  try {
    await assert.rejects(
      buildSemanticLayers(
        {
          source: fixture.source,
          ocr: fixture.ocr,
          graph: fixture.graph,
          plan,
          completions: new Map(),
          workDir,
        },
        {
          writeCompletionMarker: async (path: string, bytes: Buffer) => {
            await rename(assetsDir, displacedDir);
            await mkdir(assetsDir);
            await writeFile(join(assetsDir, "competitor.txt"), "foreign");
            await writeFile(path, bytes, { flag: "wx" });
            replacementCreated = true;
          },
        },
      ),
      /ownership|directory|publication/,
    );
    assert.equal(replacementCreated, true);
    assert.equal(await readFile(join(assetsDir, "competitor.txt"), "utf8"), "foreign");
    assert.ok((await readdir(assetsDir)).includes(".semantic-assets-complete.json"));
    assert.ok((await readdir(displacedDir)).includes(".semantic-assets-owner.json"));
    assert.equal(
      (await readdir(displacedDir)).includes(".semantic-assets-complete.json"),
      false,
    );
    await assert.rejects(
      fidelityBuild.readSemanticAssetPublication(assetsDir),
      /ownership|directory|inventory/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("retains all incomplete evidence when an asset is replaced before validation", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-assets-file-replacement-"));
  const assetsDir = join(workDir, "assets");
  const displacedAsset = join(workDir, "displaced-asset-evidence.png");
  let replacedName: string | undefined;
  let originalBytes: Buffer | undefined;
  try {
    await assert.rejects(
      buildSemanticLayers(
        {
          source: fixture.source,
          ocr: fixture.ocr,
          graph: fixture.graph,
          plan,
          completions: new Map(),
          workDir,
        },
        {
          validateAssetPublication: async (directory: string) => {
            replacedName = (await readdir(directory)).find((name) =>
              name.endsWith(".png"),
            );
            assert.ok(replacedName);
            originalBytes = await readFile(join(directory, replacedName));
            await rename(join(directory, replacedName), displacedAsset);
            await writeFile(join(directory, replacedName), "foreign replacement", {
              flag: "wx",
            });
            return fidelityBuild.readSemanticAssetPublication(directory);
          },
        },
      ),
      /hash|publication|inventory/,
    );
    assert.ok(replacedName);
    assert.deepEqual(await readFile(displacedAsset), originalBytes);
    assert.equal(
      await readFile(join(assetsDir, replacedName), "utf8"),
      "foreign replacement",
    );
    const evidence = await readdir(assetsDir);
    assert.ok(evidence.includes(".semantic-assets-owner.json"));
    assert.ok(evidence.includes(".semantic-assets-complete.json"));
    assert.ok(evidence.filter((name) => name.endsWith(".png")).length > 1);
    await assert.rejects(
      fidelityBuild.readSemanticAssetPublication(assetsDir),
      /hash|publication|inventory/,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("rejects an asset replacement between handle hashing and the final validation gate", async () => {
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-assets-reader-asset-race-"));
  const assetsDir = join(workDir, "assets");
  const displacedAsset = join(workDir, "displaced-after-hash.png");
  let injected = false;
  let originalBytes: Buffer | undefined;
  let replacementBytes: Buffer | undefined;
  let replacedAssetName: string | undefined;
  try {
    await buildSemanticLayers({
      source: fixture.source,
      ocr: fixture.ocr,
      graph: fixture.graph,
      plan,
      completions: new Map(),
      workDir,
    });

    await assert.rejects(
      fidelityBuild.readSemanticAssetPublication(assetsDir, {
        afterAssetHandlesHashed: async (assetNames: readonly string[]) => {
          const assetName = assetNames[0];
          assert.ok(assetName);
          replacedAssetName = assetName;
          const assetPath = join(assetsDir, assetName);
          originalBytes = await readFile(assetPath);
          replacementBytes = Buffer.alloc(originalBytes.length, 0x5a);
          if (replacementBytes.equals(originalBytes)) {
            assert.ok(replacementBytes.length > 0);
            replacementBytes[0] = replacementBytes[0]! ^ 0xff;
          }
          await rename(assetPath, displacedAsset);
          await writeFile(assetPath, replacementBytes, { flag: "wx" });
          injected = true;
        },
      }),
      /ownership|inventory|changed|hash/,
    );

    assert.equal(injected, true);
    assert.deepEqual(await readFile(displacedAsset), originalBytes);
    assert.ok(replacedAssetName);
    assert.deepEqual(
      await readFile(join(assetsDir, replacedAssetName)),
      replacementBytes,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("rejects an exact-name directory replacement during final inventory verification", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows prevents renaming the directory while its verification handle is open");
    return;
  }
  const fixture = await semanticFixture();
  const plan = planSemanticLayers(fixture.graph, fixture.ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-assets-reader-directory-race-"));
  const assetsDir = join(workDir, "assets");
  const replacementDir = join(workDir, "replacement-assets");
  const displacedDir = join(workDir, "displaced-assets-evidence");
  let injected = false;
  try {
    await buildSemanticLayers({
      source: fixture.source,
      ocr: fixture.ocr,
      graph: fixture.graph,
      plan,
      completions: new Map(),
      workDir,
    });
    await mkdir(replacementDir);
    const expectedNames = (await readdir(assetsDir)).sort();
    for (const name of expectedNames) {
      await copyFile(join(assetsDir, name), join(replacementDir, name));
    }

    await assert.rejects(
      fidelityBuild.readSemanticAssetPublication(assetsDir, {
        beforeFinalInventoryRead: async () => {
          await rename(assetsDir, displacedDir);
          await rename(replacementDir, assetsDir);
          injected = true;
        },
      }),
      /ownership|inventory|changed|directory/,
    );

    assert.equal(injected, true);
    assert.deepEqual((await readdir(assetsDir)).sort(), expectedNames);
    assert.deepEqual((await readdir(displacedDir)).sort(), expectedNames);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("falls back to per-member extraction when a compound mask overlaps protected text", async () => {
  const source = fillCanvas();
  const cleanBBox: BBox = { x: 40, y: 20, width: 24, height: 24 };
  const textBBox: BBox = { x: 80, y: 20, width: 32, height: 24 };
  const groupBBox: BBox = { x: 40, y: 20, width: 72, height: 24 };
  const ocrBBox: BBox = { x: 86, y: 26, width: 20, height: 12 };
  paintRect(source, cleanBBox, [52, 98, 135, 255]);
  paintRect(source, textBBox, [52, 98, 135, 255]);
  paintGlyphs(source, ocrBBox);
  source.sourceBytes = await sharp(source.rgba, {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 },
  }).png().toBuffer();

  const graph: SceneGraph = {
    graphVersion: 1,
    canvas: { width: WIDTH, height: HEIGHT },
    nodes: [
      node("background", "background", { x: 0, y: 0, width: WIDTH, height: HEIGHT }, 0),
      node("tagged", "compound-group", groupBBox, 2),
      node("tagged-clean", "foreground-object", cleanBBox, 2),
      node("tagged-text", "foreground-object", textBBox, 2),
    ],
    relations: [
      relation("tagged-clean-group", "belongs-to", "tagged-clean", "tagged"),
      relation("tagged-text-group", "belongs-to", "tagged-text", "tagged"),
    ],
  };
  const ocr: OcrResult = { lines: [line("Shield label", ocrBBox)] };
  const plan = planSemanticLayers(graph, ocr);
  const groupCandidate = plan.candidates.find(({ id }) => id === "tagged");
  assert.ok(groupCandidate);
  assert.equal(groupCandidate.kind, "compound-group");

  const workDir = await mkdtemp(join(tmpdir(), "semantic-member-fallback-"));
  try {
    const result = await buildSemanticLayers({
      source,
      ocr,
      graph,
      plan,
      completions: new Map(),
      workDir,
    });

    const elements = new Map(result.manifest.elements.map((element) => [element.id, element]));
    assert.equal(elements.has("tagged"), false);
    const cleanElement = elements.get("tagged:tagged-clean");
    assert.ok(cleanElement);
    assert.equal(cleanElement.kind, "asset");
    assert.equal(elements.has("tagged:tagged-text"), false);

    const decisions = new Map(result.decisions.map((decision) => [decision.candidateId, decision]));
    const groupDecision = decisions.get("tagged");
    assert.equal(groupDecision?.decision, "kept_in_background");
    assert.equal(groupDecision?.reason, "semantic_mask_unavailable");
    const textMemberDecision = decisions.get("tagged:tagged-text");
    assert.equal(textMemberDecision?.decision, "kept_in_background");
    assert.equal(textMemberDecision?.reason, "semantic_mask_unavailable");
    const cleanMemberDecision = decisions.get("tagged:tagged-clean");
    assert.equal(cleanMemberDecision?.decision, "accepted");
    assert.equal(result.recomposition.accepted, true);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("keeps asset candidates out of a degraded text region", async () => {
  const source = fillCanvas();
  const textBBox = { x: 40, y: 80, width: 48, height: 16 };
  const iconBBox = { x: 56, y: 82, width: 24, height: 10 };
  paintRect(source, iconBBox, [64, 120, 160, 255]);
  paintGlyphs(source, textBBox);
  source.sourceBytes = await sharp(source.rgba, {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 },
  }).png().toBuffer();
  const ocr = { lines: [line("Overlay label", textBBox)] };
  const graph: SceneGraph = {
    graphVersion: 1,
    canvas: { width: WIDTH, height: HEIGHT },
    nodes: [
      node("background", "background", { x: 0, y: 0, width: WIDTH, height: HEIGHT }, 0),
      node("icon", "foreground-object", iconBBox, 1),
    ],
    relations: [],
  };
  const plan = planSemanticLayers(graph, ocr);
  const workDir = await mkdtemp(join(tmpdir(), "semantic-build-degraded-barrier-"));
  try {
    const result = await buildSemanticLayers(
      { source, ocr, graph, plan, completions: new Map(), workDir },
      {
        buildTextMask: async () => {
          throw new Error("injected tight-text-mask failure");
        },
      },
    );

    const decisions = new Map(
      result.decisions.map((decision) => [decision.candidateId, decision]),
    );
    const degradedText = decisions.get("ocr-1");
    assert.equal(degradedText?.decision, "kept_in_background");
    assert.equal(degradedText?.reason, "text_mask_unavailable");
    const icon = decisions.get("icon");
    assert.equal(icon?.decision, "kept_in_background");
    assert.equal(icon?.reason, "semantic_mask_unavailable");
    assert.equal(result.recomposition.accepted, true);

    const glyphOffset = (84 * WIDTH + 63) * 4;
    const after = await rgbaPixels(result.background);
    assert.deepEqual(
      after.subarray(glyphOffset, glyphOffset + 4),
      source.rgba.subarray(glyphOffset, glyphOffset + 4),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
