import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetProvenanceSchema,
  OcrResultSchema,
  ProviderBBoxSchema,
  SlideManifestSchema,
  SlideManifestV2Schema,
  type SlideManifestV1,
  type SlideManifestV2,
  type VersionedSlideManifest,
  VisionResultSchema,
} from "../src/contracts.js";

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

test("preserves optional bold text style in manifest v1", () => {
  const styledManifest = structuredClone(validManifest);
  Object.assign(styledManifest.elements[0]!, { bold: true });

  const parsed = SlideManifestSchema.parse(styledManifest);

  assert.equal(parsed.elements[0]?.kind, "text");
  assert.equal(parsed.elements[0]?.bold, true);
});

test("preserves optional bounded text tracking in manifest v1", () => {
  const styledManifest = structuredClone(validManifest);
  Object.assign(styledManifest.elements[0]!, { charSpacingPx: 3 });

  const parsed = SlideManifestSchema.parse(styledManifest);

  assert.equal(parsed.elements[0]?.kind, "text");
  assert.equal(parsed.elements[0]?.charSpacingPx, 3);
  assert.throws(() =>
    SlideManifestSchema.parse({
      ...styledManifest,
      elements: [{ ...styledManifest.elements[0]!, charSpacingPx: 36.01 }],
    }),
  );
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

test("rejects a bbox that extends below the slide canvas", () => {
  const invalidManifest = structuredClone(validManifest);
  invalidManifest.elements[0]!.bbox = {
    x: 40,
    y: 700,
    width: 300,
    height: 40,
  };

  assert.throws(() => SlideManifestSchema.parse(invalidManifest));
});

const hash = (character: string): string => character.repeat(64);

const validManifestV2 = {
  manifestVersion: 2,
  canvas: { width: 1600, height: 900 },
  elements: [
    {
      kind: "asset",
      id: "object-1",
      label: "movable object",
      bbox: { x: 1300, y: 700, width: 300, height: 200 },
      extraction: "transparent",
      assetPath: "assets/object-1.png",
      zIndex: 2,
      role: "foreground-object",
      groupId: null,
      provenance: {
        kind: "source-visible",
        sourceCropSha256: hash("a"),
        visibleMaskSha256: hash("b"),
        assetSha256: hash("c"),
      },
      relations: [],
      reviewRequired: false,
    },
  ],
  warnings: [],
};

test("keeps manifest v1 readable through the versioned union", () => {
  const parsed = SlideManifestSchema.parse(validManifest);

  assert.equal(parsed.manifestVersion, 1);
});

function parseVersionedManifestForTypecheck(
  input: unknown,
): VersionedSlideManifest {
  const parsed = SlideManifestSchema.parse(input);
  if (parsed.manifestVersion === 2) {
    const manifestV2: SlideManifestV2 = parsed;
    return manifestV2;
  }
  const manifestV1: SlideManifestV1 = parsed;
  return manifestV1;
}

test("parsing unknown manifest JSON preserves discriminant narrowing", () => {
  const parsed = parseVersionedManifestForTypecheck(validManifestV2);

  assert.equal(parsed.manifestVersion, 2);
});

test("requires every semantic asset field in manifest v2", () => {
  for (const field of [
    "role",
    "groupId",
    "provenance",
    "relations",
    "reviewRequired",
  ] as const) {
    const fixture = structuredClone(validManifestV2);
    delete (fixture.elements[0]! as Record<string, unknown>)[field];
    assert.throws(() => SlideManifestV2Schema.parse(fixture));
  }
});

test("validates manifest v2 asset boxes against its dynamic canvas", () => {
  assert.doesNotThrow(() => SlideManifestSchema.parse(validManifestV2));

  const overflow = structuredClone(validManifestV2);
  overflow.elements[0]!.bbox.width = 301;
  assert.throws(() => SlideManifestSchema.parse(overflow));
});

test("parses all provider-neutral asset provenance forms", () => {
  const sourceVisible = {
    kind: "source-visible",
    sourceCropSha256: hash("1"),
    visibleMaskSha256: hash("2"),
    assetSha256: hash("3"),
  };
  const generatedHidden = {
    kind: "generated-hidden",
    sourceCropSha256: hash("4"),
    generatedMaskSha256: hash("5"),
    assetSha256: hash("6"),
    modelId: "provider-neutral-model",
    taskId: "sanitized-task-id",
    sanitizedProviderMetadata: { requestClass: "image-edit", attempts: 1 },
  };
  const composite = {
    kind: "composite",
    sourceCropSha256: hash("7"),
    visibleMaskSha256: hash("8"),
    generatedMaskSha256: hash("9"),
    assetSha256: hash("a"),
    modelId: "provider-neutral-model",
    taskId: "sanitized-task-id",
  };

  assert.deepEqual(AssetProvenanceSchema.parse(sourceVisible), sourceVisible);
  assert.deepEqual(AssetProvenanceSchema.parse(generatedHidden), generatedHidden);
  assert.deepEqual(AssetProvenanceSchema.parse(composite), composite);
  assert.throws(() =>
    AssetProvenanceSchema.parse({
      ...composite,
      generatedMaskSha256: undefined,
    }),
  );
});

test("requires review for assets containing generated hidden pixels", () => {
  for (const kind of ["generated-hidden", "composite"] as const) {
    const fixture = structuredClone(validManifestV2);
    fixture.elements[0]!.reviewRequired = false;
    (fixture.elements[0]! as Record<string, unknown>).provenance = {
      kind,
      sourceCropSha256: hash("d"),
      generatedMaskSha256: hash("e"),
      assetSha256: hash("f"),
      modelId: "provider-neutral-model",
      taskId: "sanitized-task-id",
      ...(kind === "composite" ? { visibleMaskSha256: hash("0") } : {}),
    };
    assert.throws(() => SlideManifestV2Schema.parse(fixture));
  }
});

const validOcrResult = {
  lines: [
    {
      text: "AI-Agent",
      bbox: { x: 40, y: 32, width: 300, height: 64 },
      quad: [
        { x: 40, y: 32 },
        { x: 340, y: 32 },
        { x: 340, y: 96 },
        { x: 40, y: 96 },
      ],
    },
  ],
};

test("parses representative normalized OCR output", () => {
  const parsed = OcrResultSchema.parse(validOcrResult);

  assert.equal(parsed.lines[0]?.text, "AI-Agent");
  assert.equal(parsed.lines[0]?.quad.length, 4);
});

test("provider geometry permits overflow but rejects non-finite values", () => {
  const overflow = structuredClone(validOcrResult);
  overflow.lines[0]!.bbox = { x: 1270, y: -10, width: 40, height: 80 };
  overflow.lines[0]!.quad[0] = { x: 1270, y: -10 };
  overflow.lines[0]!.quad[1] = { x: 1310, y: -10 };
  overflow.lines[0]!.quad[2] = { x: 1310, y: 70 };
  overflow.lines[0]!.quad[3] = { x: 1270, y: 70 };

  assert.doesNotThrow(() => OcrResultSchema.parse(overflow));
  assert.doesNotThrow(() =>
    ProviderBBoxSchema.parse({ x: -20, y: 800, width: 40, height: 80 }),
  );
  assert.throws(() =>
    ProviderBBoxSchema.parse({
      x: Number.POSITIVE_INFINITY,
      y: 0,
      width: 10,
      height: 10,
    }),
  );
  assert.throws(() =>
    ProviderBBoxSchema.parse({ x: 0, y: 0, width: 0, height: 10 }),
  );
});

test("parses representative vision output", () => {
  const parsed = VisionResultSchema.parse({
    elements: [
      {
        type: "panel",
        bbox: { x: 80, y: 160, width: 240, height: 320 },
        label: "content panel",
        zIndex: 2,
        editableAs: "native-shape",
        confidence: 0.95,
        fillColor: "F4EBDD",
        strokeColor: "23394D",
        cornerRadius: 16,
      },
    ],
  });

  assert.equal(parsed.elements[0]?.type, "panel");
  assert.equal(parsed.elements[0]?.editableAs, "native-shape");
});
