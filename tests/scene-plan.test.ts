import assert from "node:assert/strict";
import test from "node:test";

import type { OcrResult } from "../src/contracts.js";
import type {
  SceneGraph,
  SceneNode,
  SceneRelation,
} from "../src/scene/contracts.js";
import { planSemanticLayers } from "../src/scene/plan.js";

const canvas = { width: 1000, height: 500 };
const emptyOcr: OcrResult = { lines: [] };

function node(
  id: string,
  role: SceneNode["role"],
  bbox: SceneNode["bbox"],
  overrides: Partial<SceneNode> = {},
): SceneNode {
  return {
    id,
    role,
    bbox,
    confidence: 0.95,
    zIndex: 1,
    label: "audit-only description",
    extractionHints: [],
    ...overrides,
  };
}

function relation(
  id: string,
  kind: SceneRelation["kind"],
  from: string,
  to: string,
): SceneRelation {
  return { id, kind, from, to, confidence: 0.95 };
}

function graph(
  nodes: SceneNode[],
  relations: SceneRelation[] = [],
): SceneGraph {
  return {
    graphVersion: 1,
    canvas,
    nodes: [
      node(
        "background",
        "background",
        { x: 0, y: 0, width: 1, height: 1 },
        { confidence: 1, zIndex: 0 },
      ),
      ...nodes,
    ],
    relations,
  };
}

function ocrLine(
  text: string,
  bbox: OcrResult["lines"][number]["bbox"],
): OcrResult["lines"][number] {
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

test("keeps adjacent independent nodes separate and ignores audit labels", () => {
  const nodes = [
    node("object-z", "foreground-object", {
      x: 0.1,
      y: 0.1,
      width: 0.1,
      height: 0.2,
    }),
    node("object-a", "foreground-object", {
      x: 0.205,
      y: 0.1,
      width: 0.1,
      height: 0.2,
    }),
  ];

  const forward = planSemanticLayers(graph(nodes), emptyOcr);
  const relabeled = planSemanticLayers(
    graph(
      [...nodes]
        .reverse()
        .map((candidate, index) => ({
          ...candidate,
          label: index === 0 ? "slide-07 eye" : "wrench shield",
        })),
    ),
    emptyOcr,
  );

  assert.deepEqual(
    forward.candidates.map(({ kind, nodeIds, zOrder }) => ({
      kind,
      nodeIds,
      zOrder,
    })),
    [
      { kind: "foreground-object", nodeIds: ["object-a"], zOrder: 0 },
      { kind: "foreground-object", nodeIds: ["object-z"], zOrder: 1 },
    ],
  );
  assert.deepEqual(relabeled, forward);
});

test("combines only explicit composition and keeps transitive membership", () => {
  const scene = graph(
    [
      node("outer", "compound-group", {
        x: 0.1,
        y: 0.1,
        width: 0.5,
        height: 0.5,
      }),
      node("inner", "compound-group", {
        x: 0.15,
        y: 0.15,
        width: 0.3,
        height: 0.3,
      }),
      node("member", "foreground-object", {
        x: 0.2,
        y: 0.2,
        width: 0.1,
        height: 0.1,
      }),
      node("connector", "connector", {
        x: 0.29,
        y: 0.24,
        width: 0.15,
        height: 0.02,
      }),
      node("separate", "foreground-object", {
        x: 0.61,
        y: 0.1,
        width: 0.1,
        height: 0.1,
      }),
    ],
    [
      relation("member-inner", "belongs-to", "member", "inner"),
      relation("inner-outer", "belongs-to", "inner", "outer"),
      relation("member-connector", "connected-to", "member", "connector"),
    ],
  );

  const plan = planSemanticLayers(scene, emptyOcr);

  assert.equal(plan.candidates.length, 2);
  assert.deepEqual(plan.candidates[0], {
    id: "outer",
    kind: "compound-group",
    nodeIds: ["connector", "inner", "member", "outer"],
    bbox: { x: 100, y: 50, width: 500, height: 250 },
    zOrder: 0,
    relations: ["inner-outer", "member-connector", "member-inner"],
  });
  assert.deepEqual(plan.candidates[1]?.nodeIds, ["separate"]);
});

test("uses a canonical source node ID for connected composition without a group", () => {
  const plan = planSemanticLayers(
    graph(
      [
        node("object", "foreground-object", {
          x: 0.2,
          y: 0.2,
          width: 0.2,
          height: 0.2,
        }),
        node("connector", "connector", {
          x: 0.35,
          y: 0.25,
          width: 0.15,
          height: 0.02,
        }),
      ],
      [relation("connected", "connected-to", "object", "connector")],
    ),
    emptyOcr,
  );

  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0]?.id, "connector");
  assert.equal(plan.candidates[0]?.kind, "compound-group");
  assert.deepEqual(plan.candidates[0]?.nodeIds, ["connector", "object"]);
});

test("de-duplicates only strong geometric duplicates", () => {
  const plan = planSemanticLayers(
    graph([
      node("duplicate-b", "foreground-object", {
        x: 0.2,
        y: 0.2,
        width: 0.2,
        height: 0.2,
      }),
      node("duplicate-a", "foreground-object", {
        x: 0.202,
        y: 0.202,
        width: 0.2,
        height: 0.2,
      }),
      node("overlap-only", "foreground-object", {
        x: 0.32,
        y: 0.2,
        width: 0.2,
        height: 0.2,
      }),
    ]),
    emptyOcr,
  );

  assert.deepEqual(
    plan.candidates.map(({ id, nodeIds }) => ({ id, nodeIds })),
    [
      {
        id: "duplicate-a",
        nodeIds: ["duplicate-a", "duplicate-b"],
      },
      { id: "overlap-only", nodeIds: ["overlap-only"] },
    ],
  );
});

test("attaches a valid carries-text relation to its backing", () => {
  const scene = graph(
    [
      node("backing", "text-backing", {
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.2,
      }),
      node("scene-text", "text", {
        x: 0.12,
        y: 0.14,
        width: 0.2,
        height: 0.08,
      }),
    ],
    [relation("backing-carries", "carries-text", "backing", "scene-text")],
  );

  const plan = planSemanticLayers(scene, {
    lines: [ocrLine("generic copy", { x: 120, y: 70, width: 200, height: 40 })],
  });

  assert.deepEqual(plan.text.map(({ id }) => id), ["ocr-1"]);
  assert.deepEqual(plan.candidates, [
    {
      id: "backing",
      kind: "text-backing",
      nodeIds: ["backing"],
      bbox: { x: 100, y: 50, width: 300, height: 100 },
      zOrder: 0,
      relations: ["backing-carries"],
    },
  ]);
});

test("uses in-front-of, behind, and occlusion edges for deterministic z-order", () => {
  const nodes = [
    node("rear", "foreground-object", {
      x: 0.1,
      y: 0.1,
      width: 0.1,
      height: 0.1,
    }),
    node("middle", "foreground-object", {
      x: 0.3,
      y: 0.1,
      width: 0.1,
      height: 0.1,
    }),
    node("front", "foreground-object", {
      x: 0.5,
      y: 0.1,
      width: 0.1,
      height: 0.1,
    }),
  ];
  const relations = [
    relation("middle-front-of-rear", "in-front-of", "middle", "rear"),
    relation("middle-behind-front", "behind", "middle", "front"),
    relation("front-occludes-middle", "occludes", "front", "middle"),
  ];

  const forward = planSemanticLayers(graph(nodes, relations), emptyOcr);
  const reversed = planSemanticLayers(
    graph([...nodes].reverse(), [...relations].reverse()),
    emptyOcr,
  );

  assert.deepEqual(
    forward.candidates.map(({ nodeIds, zOrder }) => [nodeIds, zOrder]),
    [
      [["rear"], 0],
      [["middle"], 1],
      [["front"], 2],
    ],
  );
  assert.deepEqual(reversed, forward);
  assert.deepEqual(forward.candidates[1]?.occlusion, {
    occluderIds: ["front"],
    hiddenMaskRequired: true,
  });
});

test("preserves transitive z-order through a non-candidate node", () => {
  const scene = graph(
    [
      node("rear-z", "foreground-object", {
        x: 0.1,
        y: 0.1,
        width: 0.1,
        height: 0.1,
      }),
      node("front-a", "foreground-object", {
        x: 0.5,
        y: 0.1,
        width: 0.1,
        height: 0.1,
      }),
    ],
    [
      relation("rear-behind-background", "behind", "rear-z", "background"),
      relation("background-behind-front", "behind", "background", "front-a"),
    ],
  );

  const forward = planSemanticLayers(scene, emptyOcr);
  const reversed = planSemanticLayers(
    {
      ...scene,
      nodes: [...scene.nodes].reverse(),
      relations: [...scene.relations].reverse(),
    },
    emptyOcr,
  );

  assert.deepEqual(
    forward.candidates.map(({ id, zOrder }) => ({ id, zOrder })),
    [
      { id: "rear-z", zOrder: 0 },
      { id: "front-a", zOrder: 1 },
    ],
  );
  assert.deepEqual(reversed, forward);
});

test("retains source node IDs for compound occluders", () => {
  const plan = planSemanticLayers(
    graph(
      [
        node("front-group", "compound-group", {
          x: 0.4,
          y: 0.1,
          width: 0.3,
          height: 0.3,
        }),
        node("front-member", "foreground-object", {
          x: 0.45,
          y: 0.15,
          width: 0.1,
          height: 0.1,
        }),
        node("rear", "foreground-object", {
          x: 0.2,
          y: 0.2,
          width: 0.15,
          height: 0.15,
        }),
      ],
      [
        relation("membership", "belongs-to", "front-member", "front-group"),
        relation("occlusion", "occludes", "front-member", "rear"),
      ],
    ),
    emptyOcr,
  );

  assert.equal(plan.candidates[1]?.id, "front-group");
  assert.deepEqual(plan.candidates[0]?.occlusion, {
    occluderIds: ["front-member"],
    hiddenMaskRequired: true,
  });
});

test("excludes every candidate touched by a layer-order cycle", () => {
  const plan = planSemanticLayers(
    graph(
      [
        node("cycle-a", "foreground-object", {
          x: 0.1,
          y: 0.1,
          width: 0.1,
          height: 0.1,
        }),
        node("cycle-b", "foreground-object", {
          x: 0.3,
          y: 0.1,
          width: 0.1,
          height: 0.1,
        }),
        node("safe", "foreground-object", {
          x: 0.5,
          y: 0.1,
          width: 0.1,
          height: 0.1,
        }),
      ],
      [
        relation("a-front-b", "in-front-of", "cycle-a", "cycle-b"),
        relation("b-front-a", "in-front-of", "cycle-b", "cycle-a"),
      ],
    ),
    emptyOcr,
  );

  assert.deepEqual(plan.candidates.map(({ nodeIds }) => nodeIds), [["safe"]]);
  assert.deepEqual(plan.warnings, ["cycle_in_layer_order:cycle-a,cycle-b"]);
});

test("excludes a candidate when its layer-order cycle passes through background", () => {
  const scene = graph(
    [
      node("object", "foreground-object", {
        x: 0.2,
        y: 0.2,
        width: 0.2,
        height: 0.2,
      }),
    ],
    [
      relation("object-front", "in-front-of", "object", "background"),
      relation("object-behind", "behind", "object", "background"),
    ],
  );
  const plan = planSemanticLayers(scene, emptyOcr);
  const reversed = planSemanticLayers(
    {
      ...scene,
      nodes: [...scene.nodes].reverse(),
      relations: [...scene.relations].reverse(),
    },
    emptyOcr,
  );

  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.warnings, [
    "cycle_in_layer_order:background,object",
  ]);
  assert.deepEqual(reversed, plan);
});

test("keeps ambiguous substantial backing/object overlap in the background", () => {
  const plan = planSemanticLayers(
    graph([
      node("backing", "text-backing", {
        x: 0.2,
        y: 0.2,
        width: 0.3,
        height: 0.3,
      }),
      node("object", "foreground-object", {
        x: 0.22,
        y: 0.22,
        width: 0.28,
        height: 0.28,
      }),
    ]),
    emptyOcr,
  );

  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.warnings, [
    "ambiguous_substantial_overlap:backing,object",
  ]);
});

test("keeps an overlapping backing compound and independent object in background", () => {
  const scene = graph(
    [
      node("backing", "text-backing", {
        x: 0.2,
        y: 0.2,
        width: 0.3,
        height: 0.3,
      }),
      node("connector", "connector", {
        x: 0.18,
        y: 0.34,
        width: 0.05,
        height: 0.02,
      }),
      node("object", "foreground-object", {
        x: 0.22,
        y: 0.22,
        width: 0.28,
        height: 0.28,
      }),
    ],
    [relation("backing-connector", "connected-to", "backing", "connector")],
  );

  const forward = planSemanticLayers(scene, emptyOcr);
  const reversed = planSemanticLayers(
    {
      ...scene,
      nodes: [...scene.nodes].reverse(),
      relations: [...scene.relations].reverse(),
    },
    emptyOcr,
  );

  assert.deepEqual(forward.candidates, []);
  assert.deepEqual(forward.warnings, [
    "ambiguous_substantial_overlap:backing,object",
  ]);
  assert.deepEqual(reversed, forward);
});

test("keeps a backing with a dangling OCR association in the background", () => {
  const plan = planSemanticLayers(
    graph(
      [
        node("backing", "text-backing", {
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.1,
        }),
        node("scene-text", "text", {
          x: 0.12,
          y: 0.12,
          width: 0.1,
          height: 0.04,
        }),
      ],
      [relation("carries", "carries-text", "backing", "scene-text")],
    ),
    {
      lines: [ocrLine("unrelated", { x: 800, y: 400, width: 100, height: 30 })],
    },
  );

  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.warnings, [
    "dangling_ocr_association:backing,scene-text",
  ]);
});

test("keeps decoration and uncertain candidates in the background", () => {
  const plan = planSemanticLayers(
    graph([
      node("decoration", "decoration", {
        x: 0.1,
        y: 0.1,
        width: 0.1,
        height: 0.1,
      }),
      node(
        "uncertain",
        "foreground-object",
        { x: 0.3, y: 0.1, width: 0.1, height: 0.1 },
        { confidence: 0.79 },
      ),
      node(
        "boundary",
        "foreground-object",
        { x: 0.5, y: 0.1, width: 0.1, height: 0.1 },
        { confidence: 0.8 },
      ),
    ]),
    emptyOcr,
  );

  assert.deepEqual(plan.candidates.map(({ nodeIds }) => nodeIds), [["boundary"]]);
  assert.deepEqual(plan.warnings, [
    "decoration_candidate:decoration",
    "uncertain_candidate:uncertain",
  ]);
});

test("does not promote a decoration through explicit composition", () => {
  const plan = planSemanticLayers(
    graph(
      [
        node("object", "foreground-object", {
          x: 0.2,
          y: 0.2,
          width: 0.2,
          height: 0.2,
        }),
        node("decoration", "decoration", {
          x: 0.35,
          y: 0.25,
          width: 0.05,
          height: 0.05,
        }),
      ],
      [relation("decorates", "connected-to", "object", "decoration")],
    ),
    emptyOcr,
  );

  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.warnings, ["decoration_candidate:decoration"]);
});
