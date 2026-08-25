import assert from "node:assert/strict";
import test from "node:test";

import { SlideManifestSchema } from "../src/contracts.js";

const validManifest = {
  manifestVersion: 1,
  canvas: { width: 1280, height: 720 },
  elements: [
    {
      kind: "text",
      id: "title",
      text: "AI-Agent",
      bbox: { x: 40, y: 32, width: 300, height: 64 },
      rotation: 0,
      color: "23394D",
      fontSizePx: 46,
      align: "left",
      zIndex: 10,
    },
  ],
  warnings: [],
};

test("parses a version 1 slide manifest", () => {
  const parsed = SlideManifestSchema.parse(validManifest);

  assert.equal(parsed.manifestVersion, 1);
});

test("rejects a bbox that extends beyond the slide canvas", () => {
  const invalidManifest = structuredClone(validManifest);
  invalidManifest.elements[0]!.bbox = {
    x: 1200,
    y: 32,
    width: 100,
    height: 64,
  };

  assert.throws(() => SlideManifestSchema.parse(invalidManifest));
});
