import assert from "node:assert/strict";
import test from "node:test";

import sharp from "sharp";

import type { AppConfig } from "../src/config.js";
import type {
  SceneGraph,
  SceneNode,
  SceneRelation,
} from "../src/scene/contracts.js";
import {
  mergeRefinedSubgraph,
  selectRefinementRequests,
} from "../src/scene/refine.js";
import { refineSceneRegions } from "../src/providers/qwen-scene.js";

const canvas = { width: 1000, height: 500 };

function node(
  id: string,
  bbox: SceneNode["bbox"],
  overrides: Partial<SceneNode> = {},
): SceneNode {
  return {
    id,
    role: "foreground-object",
    bbox,
    confidence: 0.8,
    zIndex: 2,
    label: "generic object",
    extractionHints: [],
    ...overrides,
  };
}

function relation(
  id: string,
  kind: SceneRelation["kind"],
  from: string,
  to: string,
  confidence = 0.8,
): SceneRelation {
  return { id, kind, from, to, confidence };
}

function graph(
  nodes: SceneNode[],
  relations: SceneRelation[] = [],
  owningCanvas = canvas,
): SceneGraph {
  return {
    graphVersion: 1,
    canvas: owningCanvas,
    nodes: [
      node(
        "background",
        { x: 0, y: 0, width: 1, height: 1 },
        { role: "background", confidence: 1, zIndex: 0 },
      ),
      ...nodes,
    ],
    relations,
  };
}

const splitPair = graph(
  [
    node("split-a", { x: 0.1, y: 0.1, width: 0.1, height: 0.15 }),
    node("split-b", { x: 0.21, y: 0.1, width: 0.1, height: 0.15 }),
  ],
  [relation("split-link", "connected-to", "split-a", "split-b", 0.7)],
);

const connectedCompound = graph(
  [
    node("compound", { x: 0.35, y: 0.15, width: 0.3, height: 0.3 }, {
      role: "compound-group",
      confidence: 0.7,
    }),
    node("member", { x: 0.4, y: 0.2, width: 0.1, height: 0.1 }),
  ],
  [relation("membership", "belongs-to", "member", "compound")],
);

const nestedObject = graph(
  [
    node("outer", { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }),
    node("inner", { x: 0.3, y: 0.3, width: 0.1, height: 0.1 }),
  ],
  [relation("nested", "belongs-to", "inner", "outer")],
);

const occlusion = graph(
  [
    node("front", { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }),
    node("rear", { x: 0.3, y: 0.25, width: 0.2, height: 0.2 }),
  ],
  [relation("overlap", "occludes", "front", "rear", 0.65)],
);

const contradictoryZOrder = graph(
  [
    node("higher", { x: 0.6, y: 0.2, width: 0.2, height: 0.2 }, { zIndex: 5 }),
    node("lower", { x: 0.65, y: 0.25, width: 0.2, height: 0.2 }, { zIndex: 2 }),
  ],
  [relation("wrong-order", "behind", "higher", "lower", 0.5)],
);

test("prioritizes ambiguity by severity, confidence, area, then stable node ID", () => {
  const combined = graph(
    [
      ...contradictoryZOrder.nodes.slice(1),
      ...occlusion.nodes.slice(1),
      node("edge-z", { x: 0, y: 0.6, width: 0.1, height: 0.1 }, { confidence: 0.3 }),
      node("edge-a", { x: 0, y: 0.7, width: 0.2, height: 0.1 }, { confidence: 0.3 }),
      ...connectedCompound.nodes.slice(1),
    ],
    [
      ...contradictoryZOrder.relations,
      ...occlusion.relations,
      ...connectedCompound.relations,
    ],
  );

  const requests = selectRefinementRequests(combined, canvas, 8);

  assert.deepEqual(
    requests.map(({ reason, targetNodeIds }) => ({ reason, targetNodeIds })),
    [
      { reason: "conflicting-relations", targetNodeIds: ["higher", "lower"] },
      { reason: "occlusion", targetNodeIds: ["front", "rear"] },
      { reason: "incomplete-boundary", targetNodeIds: ["edge-a"] },
      { reason: "incomplete-boundary", targetNodeIds: ["edge-z"] },
      { reason: "compound", targetNodeIds: ["compound", "member"] },
    ],
  );
});

test("uses the complete target ID tuple when input order changes at the request cap", () => {
  const candidates = [
    node("a", { x: 0.5, y: 0.5, width: 0.125, height: 0.125 }, { confidence: 0.5 }),
    node("b", { x: 0.25, y: 0.5, width: 0.125, height: 0.125 }, { confidence: 0.5 }),
    node("c", { x: 0.75, y: 0.5, width: 0.125, height: 0.125 }, { confidence: 0.5 }),
  ];
  const relations = [
    relation("a-c", "connected-to", "a", "c", 0.5),
    relation("a-b", "connected-to", "a", "b", 0.5),
  ];
  const forward = selectRefinementRequests(graph(candidates, relations), canvas, 8);
  const reversed = selectRefinementRequests(
    graph([...candidates].reverse(), [...relations].reverse()),
    canvas,
    8,
  );

  assert.deepEqual(
    forward.map(({ targetNodeIds }) => targetNodeIds),
    [["a", "b"], ["a", "c"]],
  );
  assert.deepEqual(reversed, forward);

  const forwardCapped = selectRefinementRequests(graph(candidates, relations), canvas, 1);
  const reversedCapped = selectRefinementRequests(
    graph([...candidates].reverse(), [...relations].reverse()),
    canvas,
    1,
  );
  assert.deepEqual(forwardCapped, [forward[0]]);
  assert.deepEqual(reversedCapped, forwardCapped);
});

test("recognizes generic split, connected, nested, occluded, and contradictory fixtures", () => {
  assert.equal(selectRefinementRequests(splitPair, canvas, 8)[0]?.reason, "compound");
  assert.equal(selectRefinementRequests(connectedCompound, canvas, 8)[0]?.reason, "compound");
  assert.equal(selectRefinementRequests(nestedObject, canvas, 8)[0]?.reason, "compound");
  assert.equal(selectRefinementRequests(occlusion, canvas, 8)[0]?.reason, "occlusion");
  assert.equal(
    selectRefinementRequests(contradictoryZOrder, canvas, 8)[0]?.reason,
    "conflicting-relations",
  );
});

test("returns at most eight requests and zero disables regional analysis", () => {
  const crowded = graph(
    Array.from({ length: 12 }, (_, index) =>
      node(`edge-${String(index).padStart(2, "0")}`, {
        x: 0,
        y: index * 0.07,
        width: 0.05,
        height: 0.04,
      }),
    ),
  );

  assert.equal(selectRefinementRequests(crowded, canvas, 8).length, 8);
  assert.deepEqual(selectRefinementRequests(crowded, canvas, 0), []);
  for (const invalidLimit of [-1, 9, 1.5]) {
    assert.throws(() => selectRefinementRequests(crowded, canvas, invalidLimit));
  }
});

test("pads the minimal crop and clamps it to an arbitrary owning canvas", () => {
  const edgeGraph = graph([
    node("edge", { x: 0, y: 0, width: 0.1, height: 0.1 }),
  ]);

  assert.deepEqual(selectRefinementRequests(edgeGraph, canvas, 1)[0]?.crop, {
    x: 0,
    y: 0,
    width: 105,
    height: 53,
  });
});

test("maps local refined coordinates into the global canvas and replaces duplicates once", () => {
  const original = graph([
    node("target", { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }),
    node("unrelated", { x: 0.75, y: 0.1, width: 0.1, height: 0.1 }),
  ]);
  const request = {
    targetNodeIds: ["target"],
    crop: { x: 200, y: 100, width: 400, height: 200 },
    reason: "incomplete-boundary" as const,
  };
  const local = graph(
    [node("target", { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })],
    [],
    { width: 400, height: 200 },
  );

  const merged = mergeRefinedSubgraph(original, request, local);

  assert.deepEqual(
    merged.nodes.find(({ id }) => id === "target")?.bbox,
    { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
  );
  assert.equal(merged.nodes.filter(({ id }) => id === "target").length, 1);
  assert.deepEqual(
    merged.nodes.find(({ id }) => id === "unrelated"),
    original.nodes.find(({ id }) => id === "unrelated"),
  );
});

test("regional results cannot replace unrelated OCR or global nodes", () => {
  const original = graph([
    node("target", { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }),
    node("ocr-text", { x: 0.5, y: 0.2, width: 0.2, height: 0.1 }, { role: "text" }),
  ]);
  const request = {
    targetNodeIds: ["target"],
    crop: { x: 180, y: 80, width: 240, height: 160 },
    reason: "compound" as const,
  };
  const maliciousLocal = graph(
    [node("ocr-text", { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, { role: "text" })],
    [],
    { width: 240, height: 160 },
  );

  assert.throws(
    () => mergeRefinedSubgraph(original, request, maliciousLocal),
    /unrelated|OCR/i,
  );
  assert.throws(
    () =>
      mergeRefinedSubgraph(original, { ...request, targetNodeIds: ["ocr-text"] }, maliciousLocal),
    /OCR|global/i,
  );
});

test("drops near-identical refined duplicates while keeping distinct splits", () => {
  const original = graph([
    node("panel", { x: 0.1, y: 0.2, width: 0.6, height: 0.6 }),
  ]);
  const request = {
    targetNodeIds: ["panel"],
    crop: { x: 100, y: 100, width: 600, height: 300 },
    reason: "compound" as const,
  };
  const eyeBox = { x: 0.1, y: 0.2, width: 0.15, height: 0.3 };
  const local = graph(
    [
      node("icon-eye", eyeBox, { confidence: 0.9 }),
      node("eye-icon", eyeBox, { confidence: 0.7 }),
      node("radar-chart", { x: 0.55, y: 0.2, width: 0.3, height: 0.3 }),
    ],
    [
      relation("eye-link", "connected-to", "eye-icon", "icon-eye"),
      relation("radar-link", "connected-to", "radar-chart", "icon-eye"),
    ],
    { width: 600, height: 300 },
  );

  const merged = mergeRefinedSubgraph(original, request, local);
  const mergedIds = merged.nodes.map(({ id }) => id);

  assert.ok(mergedIds.includes("icon-eye"));
  assert.ok(mergedIds.includes("radar-chart"));
  assert.ok(!mergedIds.includes("eye-icon"));
  assert.equal(mergedIds.filter((id) => id === "icon-eye").length, 1);
  assert.ok(
    !merged.relations.some(({ id }) => id === "eye-link"),
    "relations referencing dropped duplicates must be removed",
  );
  assert.ok(merged.relations.some(({ id }) => id === "radar-link"));
});

test("refined duplicate preference keeps the refinement target ID over a higher-confidence twin", () => {
  const original = graph([
    node("panel", { x: 0.1, y: 0.2, width: 0.6, height: 0.6 }),
  ]);
  const request = {
    targetNodeIds: ["panel"],
    crop: { x: 100, y: 100, width: 600, height: 300 },
    reason: "compound" as const,
  };
  const panelBox = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
  const local = graph(
    [
      node("panel", panelBox, { confidence: 0.6 }),
      node("panel-fine", panelBox, { confidence: 0.95 }),
    ],
    [],
    { width: 600, height: 300 },
  );

  const merged = mergeRefinedSubgraph(original, request, local);
  const mergedIds = merged.nodes.map(({ id }) => id);

  assert.ok(mergedIds.includes("panel"));
  assert.ok(!mergedIds.includes("panel-fine"));
});

test("rejects a local graph whose owning canvas escapes the requested crop", () => {
  const original = graph([
    node("target", { x: 0.2, y: 0.2, width: 0.2, height: 0.2 }),
  ]);
  const request = {
    targetNodeIds: ["target"],
    crop: { x: 200, y: 100, width: 200, height: 100 },
    reason: "compound" as const,
  };
  const escaping = graph(
    [node("target", { x: 0.8, y: 0.2, width: 0.2, height: 0.2 })],
    [],
    { width: 300, height: 100 },
  );

  assert.throws(() => mergeRefinedSubgraph(original, request, escaping), /crop/i);
});

test("regional provider sends only the crop and preserves the graph with a warning on invalid output", async () => {
  const originalFetch = globalThis.fetch;
  const source = await sharp({
    create: { width: 1000, height: 500, channels: 4, background: "white" },
  }).png().toBuffer();
  const original = graph([
    node("edge", { x: 0, y: 0, width: 0.1, height: 0.1 }),
    node("ocr-text", { x: 0.6, y: 0.2, width: 0.2, height: 0.1 }, { role: "text" }),
  ]);
  const requestedImages: Buffer[] = [];
  const requestedPrompts: string[] = [];
  const config: AppConfig = {
    apiKey: "offline-secret",
    workspaceId: "workspace-123",
    dashscopeApiBase: "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1",
    dashscopeCompatibleBase:
      "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    ocrModel: "qwen3.5-ocr",
    visionModel: "qwen3-vl-plus",
    editModel: "wanx2.1-imageedit",
    requestTimeoutMs: 120_000,
    pollIntervalMs: 2_000,
    maxRegionAnalysis: 8,
  };

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{
        content: Array<{ text?: string; image_url?: { url: string } }>;
      }>;
    };
    const dataUrl = body.messages[0]!.content.find(({ image_url }) => image_url)?.image_url?.url;
    requestedPrompts.push(
      body.messages[0]!.content.find(({ text }) => text)?.text ?? "",
    );
    requestedImages.push(Buffer.from(dataUrl!.split(",")[1]!, "base64"));
    return Response.json({
      id: "regional",
      object: "chat.completion",
      created: 0,
      model: config.visionModel,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "not-json" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };

  try {
    const result = await refineSceneRegions(source, original, config);
    assert.deepEqual(result.graph, original);
    assert.equal(result.requests.length, 1);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /regional_refinement_rejected/);
    assert.match(requestedPrompts[0]!, /do not return text nodes/i);
    assert.doesNotMatch(requestedPrompts[0]!, /carries-text/i);
    assert.deepEqual(await sharp(requestedImages[0]!).metadata().then(({ width, height }) => ({ width, height })), {
      width: 105,
      height: 53,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
