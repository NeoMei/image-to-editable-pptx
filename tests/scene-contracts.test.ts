import assert from "node:assert/strict";
import test from "node:test";

import { SceneGraphSchema } from "../src/scene/contracts.js";
import { createBBoxSchema, toPixelBBox } from "../src/scene/geometry.js";

const validGraph = {
  graphVersion: 1,
  canvas: { width: 1600, height: 900 },
  nodes: [
    {
      id: "background",
      role: "background",
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      confidence: 1,
      zIndex: 0,
      label: "full slide",
      extractionHints: [],
    },
    {
      id: "backing-1",
      role: "text-backing",
      bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
      confidence: 0.94,
      zIndex: 2,
      label: "text backing",
      extractionHints: ["preserve rounded boundary"],
    },
    {
      id: "text-1",
      role: "text",
      bbox: { x: 0.15, y: 0.25, width: 0.2, height: 0.1 },
      confidence: 0.99,
      zIndex: 3,
      label: "OCR text",
      extractionHints: [],
    },
  ],
  relations: [
    {
      id: "relation-1",
      kind: "carries-text",
      from: "backing-1",
      to: "text-1",
      confidence: 0.96,
    },
  ],
};

test("rejects normalized boxes outside the unit canvas", () => {
  const invalidBoxes = [
    { x: -0.01, y: 0, width: 0.2, height: 0.2 },
    { x: 0, y: 1.01, width: 0.2, height: 0.2 },
    { x: 0, y: 0, width: 0, height: 0.2 },
    { x: 0, y: 0, width: 0.2, height: 1.01 },
    { x: 0.9, y: 0, width: 0.2, height: 0.2 },
    { x: 0, y: 0.9, width: 0.2, height: 0.2 },
  ];

  for (const bbox of invalidBoxes) {
    const graph = structuredClone(validGraph);
    graph.nodes[1]!.bbox = bbox;
    assert.throws(() => SceneGraphSchema.parse(graph));
  }
});

test("rejects duplicate node and relation IDs", () => {
  const duplicateNode = structuredClone(validGraph);
  duplicateNode.nodes[2]!.id = "backing-1";
  assert.throws(() => SceneGraphSchema.parse(duplicateNode));

  const duplicateRelation = structuredClone(validGraph);
  duplicateRelation.relations.push({
    ...duplicateRelation.relations[0]!,
    from: "backing-1",
    to: "text-1",
  });
  assert.throws(() => SceneGraphSchema.parse(duplicateRelation));
});

test("rejects dangling relation endpoints", () => {
  for (const endpoint of ["from", "to"] as const) {
    const graph = structuredClone(validGraph);
    graph.relations[0]![endpoint] = "missing-node";
    assert.throws(() => SceneGraphSchema.parse(graph));
  }
});

test("requires exactly one background node", () => {
  const noBackground = structuredClone(validGraph);
  noBackground.nodes = noBackground.nodes.filter(
    (node) => node.role !== "background",
  );
  assert.throws(() => SceneGraphSchema.parse(noBackground));

  const twoBackgrounds = structuredClone(validGraph);
  twoBackgrounds.nodes.push({
    ...twoBackgrounds.nodes[0]!,
    id: "background-2",
  });
  assert.throws(() => SceneGraphSchema.parse(twoBackgrounds));
});

test("allows carries-text only from a text backing to text", () => {
  const reversed = structuredClone(validGraph);
  reversed.relations[0]!.from = "text-1";
  reversed.relations[0]!.to = "backing-1";
  assert.throws(() => SceneGraphSchema.parse(reversed));

  const wrongTarget = structuredClone(validGraph);
  wrongTarget.relations[0]!.to = "background";
  assert.throws(() => SceneGraphSchema.parse(wrongTarget));
});

test("rounds normalized pixel edges without overflowing the canvas", () => {
  assert.deepEqual(
    toPixelBBox(
      { x: 1 / 3, y: 1 / 3, width: 2 / 3, height: 2 / 3 },
      { width: 1001, height: 701 },
    ),
    { x: 334, y: 234, width: 667, height: 467 },
  );
});

test("validates pixel boxes against their owning canvas", () => {
  const largeCanvasSchema = createBBoxSchema({ width: 2000, height: 1000 });

  assert.doesNotThrow(() =>
    largeCanvasSchema.parse({ x: 1500, y: 900, width: 500, height: 100 }),
  );
  assert.throws(() =>
    largeCanvasSchema.parse({ x: 1500, y: 900, width: 501, height: 100 }),
  );
  assert.throws(() =>
    largeCanvasSchema.parse({ x: 1500, y: 900, width: 500, height: 101 }),
  );
});

test("round-trips graph JSON through the strict schema", () => {
  const serialized = JSON.stringify(validGraph);
  const parsed = SceneGraphSchema.parse(JSON.parse(serialized));

  assert.deepEqual(parsed, validGraph);

  const graphWithUnknownField = {
    ...structuredClone(validGraph),
    providerPayload: "must not leak into the graph",
  };
  assert.throws(() => SceneGraphSchema.parse(graphWithUnknownField));
});
