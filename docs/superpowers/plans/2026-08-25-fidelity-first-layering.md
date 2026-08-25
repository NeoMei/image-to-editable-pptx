# Fidelity-First Slide Layering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fidelity-first slide conversion path that always extracts the ten OCR text regions on slide 7, extracts only high-quality transparent icon groups, and preserves panels, bars, borders, shadows, and texture in the background without default generative inpainting.

**Architecture:** Keep live OCR and Qwen3-VL analysis, then convert their output into fidelity candidates rather than a fully editable structural manifest. Process required text candidates first with tight pixel masks and deterministic local repair; process icon groups second with transparent extraction, local repair, and source recomposition gates. Publish only accepted elements, preserve every rejected icon in the background, and record each decision in a versioned ledger.

**Tech Stack:** Node.js 22.6+, TypeScript 5.9, Sharp 0.34, Zod 4, PptxGenJS 4.0.1, Node test runner, Alibaba Model Studio (`qwen3.5-ocr`, `qwen3-vl-plus`; Wanx retained outside the default acceptance path).

## Global Constraints

- The source image remains exactly 1280×720 PNG.
- OCR coordinates are absolute source pixels; Qwen3-VL coordinates are normalized `[0, 999]` and are converted with `round(norm / 1000 * dimension)`.
- All reliable OCR text is required; slide 7 must export exactly ten editable OCR text elements.
- Panels, bars, borders, shadows, paper texture, and small decoration stay in the background.
- An icon may be editable only when extraction is transparent and recomposition quality passes; rectangular crops are diagnostic-only.
- A rejected icon must remain untouched in the background.
- Pixels outside an accepted candidate mask must remain byte-identical.
- Default background repair is deterministic and local. The live slide 7 acceptance path must not call Wanx.
- A failed required-text repair fails the page; a failed icon repair only rejects that icon.
- Failed runs preserve the previous owned success and retain staged evidence.
- Credentials and signed result URLs must never enter code, fixtures, ledgers, recordings, commits, or command output.
- Use TDD for every behavior change: write one failing test, observe the expected failure, implement the minimum production change, then run focused and full tests.

---

## File Structure

### Existing files to modify

- `src/providers/qwen-vision.ts` — normalize Qwen3-VL coordinates and constrain the prompt to the official coordinate contract.
- `src/providers/wanx-edit.ts` — retain the exact authenticated OSS result host observed during live acceptance without broadening SSRF protection.
- `src/contracts.ts` — add fidelity decision and run-ledger schemas while preserving manifest v1 compatibility.
- `src/pipeline.ts` — replace default combined-mask Wanx build with the fidelity builder and publish ledger v2.
- `src/export/pptx.ts` — continue exporting one background followed by accepted text and icon layers; reject rectangular assets in fidelity output.
- `README.md` — describe fidelity-first behavior, local repair, optional/rejected icons, API calls, and acceptance commands.
- `tests/qwen-vision.test.ts`, `tests/wanx-edit.test.ts`, `tests/planner.test.ts` — lock provider fixes and normalized fixture expectations.
- `tests/pipeline.test.ts`, `tests/pptx.test.ts`, `tests/accept-script.test.ts` — lock fidelity output, publication behavior, and the live acceptance contract.

### New files

- `src/fidelity/candidates.ts` — turn OCR and Vision results into required text candidates and panel-scoped icon groups.
- `src/fidelity/build.ts` — orchestrate per-candidate extraction, repair, validation, acceptance, and rollback.
- `src/image/text-mask.ts` — build tight glyph-oriented masks from OCR boxes and local surface color.
- `src/image/local-repair.ts` — deterministically fill one small binary mask while preserving all other pixels.
- `src/image/asset-mask.ts` — place extracted alpha into a full-canvas icon removal mask.
- `src/image/recompose.ts` — composite an icon back onto a candidate background and compute fidelity metrics.
- `tests/fidelity-candidates.test.ts` — candidate priority, structural preservation, grouping, and OCR-only text tests.
- `tests/text-mask.test.ts` — tight mask and surface-color tests.
- `tests/local-repair.test.ts` — outside-mask invariance, accepted uniform surfaces, and rejected mixed surfaces.
- `tests/asset-mask.test.ts` — alpha placement and clipping tests.
- `tests/recompose.test.ts` — passing exact reconstruction and failing rectangular/hallucinated reconstruction tests.
- `tests/fidelity-build.test.ts` — text-required/icon-optional orchestration and per-candidate ledger tests.

---

### Task 1: Checkpoint Live Provider Contract Repairs

**Files:**
- Modify: `src/providers/qwen-vision.ts`
- Modify: `src/providers/wanx-edit.ts`
- Modify: `tests/fixtures/qwen-vision-slide-07.json`
- Modify: `tests/qwen-vision.test.ts`
- Modify: `tests/wanx-edit.test.ts`
- Modify: `tests/planner.test.ts`

**Interfaces:**
- Consumes: authenticated live evidence already captured in this worktree.
- Produces: `parseQwenVisionContent(content): VisionResult` with pixel bboxes, and `inpaintBackground(...)` that accepts only documented DashScope result hosts plus the exact observed authenticated host.

- [ ] **Step 1: Review the existing uncommitted provider diff**

Run:

```bash
git diff -- src/providers/qwen-vision.ts src/providers/wanx-edit.ts tests/fixtures/qwen-vision-slide-07.json tests/qwen-vision.test.ts tests/wanx-edit.test.ts tests/planner.test.ts
```

Confirm the production invariants are exactly:

```ts
const NORMALIZED_COORDINATE_MAX = 1000;
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;

const left = Math.round((bbox[0] / NORMALIZED_COORDINATE_MAX) * CANVAS_WIDTH);
const top = Math.round((bbox[1] / NORMALIZED_COORDINATE_MAX) * CANVAS_HEIGHT);
```

and the extra Wanx allowlist entry is the single exact hostname:

```ts
const DASHSCOPE_OBSERVED_RESULT_HOSTS = new Set([
  "dashscope-5859.oss-cn-wulanchabu-acdr-1.aliyuncs.com",
]);
```

Do not replace it with a wildcard such as `*.oss-cn-*.aliyuncs.com`.

- [ ] **Step 2: Run the focused provider tests**

Run:

```bash
node --import tsx --test tests/qwen-vision.test.ts tests/wanx-edit.test.ts tests/planner.test.ts
```

Expected: all focused tests pass, including `converts Qwen3-VL normalized coordinates` and `accepts the authenticated Wanx ACDR result bucket`.

- [ ] **Step 3: Run the complete offline gate**

Run:

```bash
npm test
npm run lint:types
npm run build
npm run test:compiled
```

Expected: 80 source tests and 80 compiled tests pass; typecheck and build exit 0.

- [ ] **Step 4: Commit only the provider-contract repair**

```bash
git add src/providers/qwen-vision.ts src/providers/wanx-edit.ts tests/fixtures/qwen-vision-slide-07.json tests/qwen-vision.test.ts tests/wanx-edit.test.ts tests/planner.test.ts
git commit -m "fix: align live Model Studio provider contracts"
```

---

### Task 2: Plan Fidelity Candidates Without Rebuilding Structural Furniture

**Files:**
- Create: `src/fidelity/candidates.ts`
- Create: `tests/fidelity-candidates.test.ts`
- Modify: `src/contracts.ts`

**Interfaces:**
- Consumes: `OcrResult`, `VisionResult`, `BBox`, and `SlideElement` from `src/contracts.ts`.
- Produces: `planFidelityCandidates(ocr: OcrResult, vision: VisionResult): FidelityPlan`.
- Produces: `FidelityTextCandidate`, `FidelityIconCandidate`, and `FidelityPlan`.

- [ ] **Step 1: Add the failing candidate tests**

Create `tests/fidelity-candidates.test.ts` with these concrete cases:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import type { OcrResult, VisionResult } from "../src/contracts.js";
import { planFidelityCandidates } from "../src/fidelity/candidates.js";

const ocr: OcrResult = {
  lines: Array.from({ length: 10 }, (_, index) => ({
    text: `text-${index + 1}`,
    bbox: { x: 20, y: 20 + index * 50, width: 120, height: 24 },
    quad: [
      { x: 20, y: 20 + index * 50 },
      { x: 140, y: 20 + index * 50 },
      { x: 140, y: 44 + index * 50 },
      { x: 20, y: 44 + index * 50 },
    ],
  })),
};

const vision: VisionResult = {
  elements: [
    {
      type: "panel",
      bbox: { x: 300, y: 100, width: 300, height: 300 },
      label: "execution panel",
      zIndex: 1,
      editableAs: "native-shape",
      confidence: 0.99,
    },
    {
      type: "icon",
      bbox: { x: 340, y: 160, width: 100, height: 120 },
      label: "wrench",
      zIndex: 2,
      editableAs: "bitmap",
      confidence: 0.99,
    },
    {
      type: "icon",
      bbox: { x: 455, y: 230, width: 70, height: 70 },
      label: "shield",
      zIndex: 3,
      editableAs: "bitmap",
      confidence: 0.98,
    },
    {
      type: "shape",
      bbox: { x: 0, y: 600, width: 1280, height: 100 },
      label: "bottom bar",
      zIndex: 1,
      editableAs: "native-shape",
      confidence: 0.99,
    },
  ],
};

test("plans all OCR text but keeps panels and bars in the background", () => {
  const plan = planFidelityCandidates(ocr, vision);
  assert.equal(plan.text.length, 10);
  assert.equal(plan.text.every((candidate) => candidate.required), true);
  assert.equal(plan.icons.length, 1);
  assert.equal(plan.icons[0]?.label, "wrench + shield");
  assert.deepEqual(plan.icons[0]?.sourceElementIndexes, [1, 2]);
  assert.equal(
    plan.icons.some((candidate) => /panel|bar/i.test(candidate.label)),
    false,
  );
});
```

- [ ] **Step 2: Run the test and observe the missing module failure**

Run:

```bash
node --import tsx --test tests/fidelity-candidates.test.ts
```

Expected: FAIL because `src/fidelity/candidates.ts` does not exist.

- [ ] **Step 3: Add the candidate types**

Append these exported types to `src/contracts.ts`:

```ts
export type TextSlideElement = Extract<SlideElement, { kind: "text" }>;

export type FidelityTextCandidate = {
  kind: "text";
  id: string;
  required: true;
  element: TextSlideElement;
};

export type FidelityIconCandidate = {
  kind: "icon";
  id: string;
  label: string;
  bbox: BBox;
  zIndex: number;
  sourceElementIndexes: number[];
};

export type FidelityPlan = {
  canvas: { width: 1280; height: 720 };
  text: FidelityTextCandidate[];
  icons: FidelityIconCandidate[];
  warnings: string[];
};
```

- [ ] **Step 4: Implement panel-scoped grouping**

Create `src/fidelity/candidates.ts`. The implementation must:

```ts
import type {
  BBox,
  FidelityIconCandidate,
  FidelityPlan,
  OcrResult,
  VisionResult,
} from "../contracts.js";
import { planSlide } from "../planner.js";

const union = (left: BBox, right: BBox): BBox => {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottom = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottom - y };
};

const centerInside = (inner: BBox, outer: BBox): boolean => {
  const x = inner.x + inner.width / 2;
  const y = inner.y + inner.height / 2;
  return (
    x >= outer.x && x <= outer.x + outer.width &&
    y >= outer.y && y <= outer.y + outer.height
  );
};

export function planFidelityCandidates(
  ocr: OcrResult,
  vision: VisionResult,
): FidelityPlan {
  const text = planSlide(ocr, { elements: [] }).elements
    .filter((element) => element.kind === "text")
    .map((element) => ({
      kind: "text" as const,
      id: element.id,
      required: true as const,
      element,
    }));

  const panels = vision.elements
    .map((element, sourceIndex) => ({ element, sourceIndex }))
    .filter(({ element }) => element.type === "panel");
  const bitmap = vision.elements
    .map((element, sourceIndex) => ({ element, sourceIndex }))
    .filter(
      ({ element }) =>
        element.editableAs === "bitmap" &&
        (element.type === "icon" || element.type === "illustration"),
    );

  const grouped = new Map<number, typeof bitmap>();
  const ungrouped: typeof bitmap = [];
  for (const candidate of bitmap) {
    const panel = panels.find(({ element }) =>
      centerInside(candidate.element.bbox, element.bbox),
    );
    if (panel === undefined) {
      ungrouped.push(candidate);
      continue;
    }
    const items = grouped.get(panel.sourceIndex) ?? [];
    items.push(candidate);
    grouped.set(panel.sourceIndex, items);
  }

  const icons: FidelityIconCandidate[] = [
    ...[...grouped.entries()].map(([panelIndex, items]) => ({
      kind: "icon" as const,
      id: `icon-panel-${panelIndex + 1}`,
      label: items.map(({ element }) => element.label).join(" + "),
      bbox: items.map(({ element }) => element.bbox).reduce(union),
      zIndex: Math.max(...items.map(({ element }) => element.zIndex)),
      sourceElementIndexes: items.map(({ sourceIndex }) => sourceIndex),
    })),
    ...ungrouped.map(({ element, sourceIndex }) => ({
      kind: "icon" as const,
      id: `icon-${sourceIndex + 1}`,
      label: element.label,
      bbox: element.bbox,
      zIndex: element.zIndex,
      sourceElementIndexes: [sourceIndex],
    })),
  ];

  return {
    canvas: { width: 1280, height: 720 },
    text,
    icons,
    warnings: [],
  };
}
```

During implementation, add clipping before grouping by reusing the same 1280×720 intersection behavior as `planSlide`; fully non-intersecting visual candidates are omitted and any clipping adds `out_of_bounds_clipped` once.

- [ ] **Step 5: Run focused and full tests**

```bash
node --import tsx --test tests/fidelity-candidates.test.ts tests/planner.test.ts
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/contracts.ts src/fidelity/candidates.ts tests/fidelity-candidates.test.ts
git commit -m "feat: plan fidelity-first slide candidates"
```

---

### Task 3: Build Tight OCR Text Masks

**Files:**
- Create: `src/image/text-mask.ts`
- Create: `tests/text-mask.test.ts`

**Interfaces:**
- Consumes: source PNG and `TextSlideElement`.
- Produces: `buildTightTextMask(source: Buffer, element: TextSlideElement, options?: TextMaskOptions): Promise<TextMaskResult>`.
- Produces: full-canvas black/white PNG mask plus `maskedPixels` and sampled `surfaceRgb`.

- [ ] **Step 1: Write the failing tight-mask tests**

Use a small raw bitmap rather than font rendering so the expected pixels are exact:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import type { TextSlideElement } from "../src/contracts.js";
import { buildTightTextMask } from "../src/image/text-mask.js";

test("masks contrasting glyph pixels without masking the full OCR box", async () => {
  const width = 16;
  const height = 10;
  const raw = Buffer.alloc(width * height * 3, 30);
  for (const [x, y] of [[6, 4], [7, 4], [7, 5]]) {
    const offset = (y * width + x) * 3;
    raw[offset] = 240;
    raw[offset + 1] = 240;
    raw[offset + 2] = 240;
  }
  const source = await sharp(raw, {
    raw: { width, height, channels: 3 },
  }).png().toBuffer();
  const element: TextSlideElement = {
    kind: "text",
    id: "ocr-1",
    text: "A",
    bbox: { x: 4, y: 2, width: 8, height: 6 },
    rotation: 0,
    color: "FFFFFF",
    fontSizePx: 18,
    align: "left",
    zIndex: 100,
  };

  const result = await buildTightTextMask(source, element, { dilationPx: 0 });
  const mask = await sharp(result.mask).removeAlpha().raw().toBuffer();
  const value = (x: number, y: number) => mask[(y * width + x) * 3];
  assert.equal(result.maskedPixels, 3);
  assert.equal(value(6, 4), 255);
  assert.equal(value(4, 2), 0);
  assert.equal(value(11, 7), 0);
  assert.deepEqual(result.surfaceRgb, [30, 30, 30]);
});
```

Add a second test where the perimeter contains two incompatible surfaces; expect `buildTightTextMask` to throw `Text mask surface is not locally consistent` before producing an unsafe full-box mask.

- [ ] **Step 2: Run the test and verify RED**

```bash
node --import tsx --test tests/text-mask.test.ts
```

Expected: FAIL because `src/image/text-mask.ts` is missing.

- [ ] **Step 3: Implement the mask builder**

Create `src/image/text-mask.ts` with these exact contracts and constants:

```ts
import sharp from "sharp";
import type { TextSlideElement } from "../contracts.js";

export type TextMaskOptions = {
  colorDistance?: number;
  dilationPx?: number;
};

export type TextMaskResult = {
  mask: Buffer;
  maskedPixels: number;
  surfaceRgb: readonly [number, number, number];
};

const DEFAULT_COLOR_DISTANCE = 32;
const DEFAULT_DILATION_PX = 1;
const MAX_SURFACE_CHANNEL_MAD = 18;
```

Implementation sequence:

```ts
// 1. Decode source with ensureAlpha().raw().
// 2. Clamp floor/ceil OCR bounds to the source canvas.
// 3. Sample the one-pixel perimeter immediately outside the OCR box.
// 4. Compute channel medians and median absolute deviation.
// 5. Reject when any channel MAD exceeds 18 or fewer than 8 perimeter pixels exist.
// 6. Inside the OCR box, mark pixels whose max channel distance from the
//    perimeter median is >= colorDistance.
// 7. Dilate only those marked pixels by dilationPx; never fill the entire bbox.
// 8. Encode a full-canvas one-channel mask as PNG, with 255 for removal.
```

Validate options with finite non-negative checks. Throw `Text mask did not find contrasting glyph pixels for <id>` when `maskedPixels === 0` so required text cannot silently remain duplicated.

- [ ] **Step 4: Run focused tests**

```bash
node --import tsx --test tests/text-mask.test.ts
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/image/text-mask.ts tests/text-mask.test.ts
git commit -m "feat: build tight OCR text masks"
```

---

### Task 4: Add Deterministic Local Repair With Pixel Invariance

**Files:**
- Create: `src/image/local-repair.ts`
- Create: `tests/local-repair.test.ts`
- Modify: `src/contracts.ts`

**Interfaces:**
- Consumes: source PNG and same-size binary mask PNG.
- Produces: `repairLocalRegion(source: Buffer, mask: Buffer): Promise<LocalRepairResult>`.
- Produces metrics used by fidelity decisions: masked pixels, outside-mask changes, ring samples, ring channel MAD, and filled-pixel p95 distance.

- [ ] **Step 1: Write failing repair tests**

Create three tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { repairLocalRegion } from "../src/image/local-repair.js";

async function encodeRgb(
  data: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function encodeMask(
  data: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

test("fills a small hole from the nearest same-surface pixels", async () => {
  const width = 12;
  const height = 8;
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const value = 240 + (index % 5) - 2;
    rgb[index * 3] = value;
    rgb[index * 3 + 1] = value - 4;
    rgb[index * 3 + 2] = value - 10;
  }
  const mask = Buffer.alloc(width * height);
  for (const [x, y] of [[5, 3], [6, 3], [5, 4], [6, 4]]) {
    mask[y * width + x] = 255;
    rgb[(y * width + x) * 3] = 20;
    rgb[(y * width + x) * 3 + 1] = 20;
    rgb[(y * width + x) * 3 + 2] = 20;
  }
  const result = await repairLocalRegion(
    await encodeRgb(rgb, width, height),
    await encodeMask(mask, width, height),
  );
  const output = await sharp(result.image).removeAlpha().raw().toBuffer();
  assert.equal(result.accepted, true);
  assert.equal(result.metrics.maskedPixels, 4);
  assert.ok(output[(3 * width + 5) * 3]! >= 235);
});

test("does not change any pixel outside the mask", async () => {
  const width = 8;
  const height = 6;
  const rgb = Buffer.alloc(width * height * 3, 220);
  const mask = Buffer.alloc(width * height);
  mask[3 * width + 4] = 255;
  const source = await encodeRgb(rgb, width, height);
  const result = await repairLocalRegion(
    source,
    await encodeMask(mask, width, height),
  );
  const [before, after] = await Promise.all([
    sharp(source).ensureAlpha().raw().toBuffer(),
    sharp(result.image).ensureAlpha().raw().toBuffer(),
  ]);
  for (let index = 0; index < width * height; index += 1) {
    if (mask[index] !== 0) continue;
    assert.deepEqual(
      after.subarray(index * 4, index * 4 + 4),
      before.subarray(index * 4, index * 4 + 4),
    );
  }
  assert.equal(result.metrics.outsideMaskChangedPixels, 0);
});

test("rejects a mask whose sampling ring crosses incompatible surfaces", async () => {
  const width = 12;
  const height = 8;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = x < width / 2 ? [35, 57, 77] : [230, 93, 22];
      const offset = (y * width + x) * 3;
      rgb.set(color, offset);
    }
  }
  const mask = Buffer.alloc(width * height);
  for (let y = 2; y <= 5; y += 1) {
    for (let x = 5; x <= 6; x += 1) mask[y * width + x] = 255;
  }
  const source = await encodeRgb(rgb, width, height);
  const result = await repairLocalRegion(
    source,
    await encodeMask(mask, width, height),
  );
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "surface_variance_too_high");
  assert.deepEqual(result.image, source);
});
```

Use explicit raw pixel buffers in all three tests; do not use network calls or snapshot-only assertions.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import tsx --test tests/local-repair.test.ts
```

Expected: FAIL because the repair module is missing.

- [ ] **Step 3: Add repair metrics to contracts**

Add to `src/contracts.ts`:

```ts
export type LocalRepairReason =
  | "mask_empty"
  | "surface_samples_insufficient"
  | "surface_variance_too_high"
  | "filled_pixels_too_different";

export type LocalRepairMetrics = {
  maskedPixels: number;
  outsideMaskChangedPixels: number;
  ringSamples: number;
  ringChannelMad: number;
  filledPixelDistanceP95: number;
};

export type LocalRepairResult = {
  image: Buffer;
  accepted: boolean;
  metrics: LocalRepairMetrics;
  reason?: LocalRepairReason;
};
```

- [ ] **Step 4: Implement deterministic nearest-surface repair**

Create `src/image/local-repair.ts` with these fixed gates:

```ts
const MIN_RING_SAMPLES = 16;
const MAX_RING_CHANNEL_MAD = 18;
const MAX_FILLED_PIXEL_DISTANCE_P95 = 28;
```

The implementation must:

1. Decode source as four-channel raw pixels and mask as one-channel raw pixels.
2. Require identical dimensions.
3. Identify mask pixels at `>= 128`.
4. Collect unique four-neighbor unmasked ring pixels.
5. Reject insufficient or high-variance rings without mutating source.
6. Run a multi-source breadth-first search seeded by ring pixels; store the nearest seed index for each visited masked pixel.
7. Copy the seed RGB into masked pixels and retain source alpha.
8. Compare every unmasked output pixel byte-for-byte with source.
9. Compute filled-pixel max-channel distance to the ring median and its p95.
10. Return the original source buffer with `accepted: false` when a gate fails.

Use `Int32Array(width * height)` for the queue and nearest-seed table. Do not use a recursive flood fill.

- [ ] **Step 5: Run focused and full tests**

```bash
node --import tsx --test tests/local-repair.test.ts
npm test
```

Expected: all tests pass and no existing Sharp tests regress.

- [ ] **Step 6: Commit**

```bash
git add src/contracts.ts src/image/local-repair.ts tests/local-repair.test.ts
git commit -m "feat: add deterministic local background repair"
```

---

### Task 5: Build Transparent Icon Assets and Alpha Removal Masks

**Files:**
- Modify: `src/image/extract.ts`
- Modify: `tests/extract.test.ts`
- Create: `src/image/asset-mask.ts`
- Create: `tests/asset-mask.test.ts`

**Interfaces:**
- Consumes: text-clean source PNG, icon candidate bbox, and transparent extracted asset.
- Produces: `ExtractedAsset.metrics` and `buildAssetRemovalMask(asset, bbox, canvas): Promise<Buffer>`.
- Rejects: every rectangular extraction from fidelity publication.

- [ ] **Step 1: Extend extraction tests with border and metrics gates**

Add tests that require the following result shape:

```ts
assert.deepEqual(extracted.metrics, {
  transparentRatio: 0.75,
  opaqueBorderRatio: 0,
  foregroundPixels: 144,
});
```

Add a synthetic candidate whose foreground touches more than 2% of the crop perimeter. Expect:

```ts
assert.equal(extracted.extraction, "rectangular");
assert.equal(extracted.fallbackReason, "opaque_border_ratio_above_2_percent");
```

- [ ] **Step 2: Run the extraction tests and verify RED**

```bash
node --import tsx --test tests/extract.test.ts
```

Expected: FAIL because `metrics` and the new reason do not exist.

- [ ] **Step 3: Extend `ExtractedAsset` and calculate alpha metrics**

Modify `src/image/extract.ts`:

```ts
export type ExtractedAsset = {
  image: Buffer;
  extraction: AssetExtraction;
  metrics: {
    transparentRatio: number;
    opaqueBorderRatio: number;
    foregroundPixels: number;
  };
  fallbackReason?:
    | "edge_colors_inconsistent"
    | "transparent_pixel_ratio_below_5_percent"
    | "transparent_pixel_ratio_above_92_percent"
    | "opaque_border_ratio_above_2_percent";
};
```

After connected background removal, count alpha `>= 128` on the unique perimeter and reject when:

```ts
const MAX_OPAQUE_BORDER_RATIO = 0.02;
if (opaqueBorderRatio > MAX_OPAQUE_BORDER_RATIO) {
  return rectangularFallback(
    rectangularImage,
    metrics,
    "opaque_border_ratio_above_2_percent",
  );
}
```

Every return branch must include metrics; use zeros only when no alpha pass was attempted because the requested extraction was explicitly rectangular.

- [ ] **Step 4: Write the failing asset-mask tests**

Create `tests/asset-mask.test.ts`:

```ts
test("places asset alpha at its canvas bbox without masking transparent pixels", async () => {
  const pixels = Buffer.alloc(4 * 4 * 4);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
    pixels[(y * 4 + x) * 4 + 3] = 255;
  }
  const asset = await sharp(pixels, {
    raw: { width: 4, height: 4, channels: 4 },
  }).png().toBuffer();
  const mask = await buildAssetRemovalMask(
    asset,
    { x: 10, y: 20, width: 4, height: 4 },
    { width: 32, height: 32 },
    0,
  );
  const raw = await sharp(mask).removeAlpha().raw().toBuffer();
  const value = (x: number, y: number) => raw[(y * 32 + x) * 3];
  assert.equal(value(11, 21), 255);
  assert.equal(value(12, 22), 255);
  assert.equal(value(10, 20), 0);
  assert.equal(value(13, 23), 0);
});

test("dilates alpha by the requested pixel radius", async () => {
  const pixels = Buffer.alloc(3 * 3 * 4);
  pixels[(1 * 3 + 1) * 4 + 3] = 255;
  const asset = await sharp(pixels, {
    raw: { width: 3, height: 3, channels: 4 },
  }).png().toBuffer();
  const mask = await buildAssetRemovalMask(
    asset,
    { x: 4, y: 4, width: 3, height: 3 },
    { width: 12, height: 12 },
    1,
  );
  const raw = await sharp(mask).removeAlpha().raw().toBuffer();
  const value = (x: number, y: number) => raw[(y * 12 + x) * 3];
  assert.equal(value(4, 4), 255);
  assert.equal(value(6, 6), 255);
  assert.equal(value(3, 3), 0);
  assert.equal(value(7, 7), 0);
});
```

- [ ] **Step 5: Implement `buildAssetRemovalMask`**

Create `src/image/asset-mask.ts`:

```ts
import sharp from "sharp";
import type { BBox } from "../contracts.js";

export async function buildAssetRemovalMask(
  asset: Buffer,
  bbox: BBox,
  canvas: { width: number; height: number },
  dilationPx = 2,
): Promise<Buffer> {
  const { data, info } = await sharp(asset)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = Math.ceil(bbox.width);
  const height = Math.ceil(bbox.height);
  if (info.width !== width || info.height !== height) {
    throw new Error("Asset dimensions do not match candidate bbox");
  }
  if (!Number.isInteger(dilationPx) || dilationPx < 0) {
    throw new RangeError("Asset mask dilation must be a non-negative integer");
  }

  const foreground = new Uint8Array(width * height);
  for (let index = 0; index < foreground.length; index += 1) {
    foreground[index] = data[index * 4 + 3]! >= 16 ? 255 : 0;
  }
  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (foreground[y * width + x] === 0) continue;
      for (let dy = -dilationPx; dy <= dilationPx; dy += 1) {
        for (let dx = -dilationPx; dx <= dilationPx; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            dilated[py * width + px] = 255;
          }
        }
      }
    }
  }

  const canvasMask = Buffer.alloc(canvas.width * canvas.height);
  const left = Math.floor(bbox.x);
  const top = Math.floor(bbox.y);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const targetX = left + x;
      const targetY = top + y;
      if (
        targetX >= 0 && targetX < canvas.width &&
        targetY >= 0 && targetY < canvas.height
      ) {
        canvasMask[targetY * canvas.width + targetX] =
          dilated[y * width + x]!;
      }
    }
  }
  return sharp(canvasMask, {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  }).png().toBuffer();
}
```

Validate that the decoded asset dimensions match the integer bbox crop. A mismatch must throw `Asset dimensions do not match candidate bbox`.

- [ ] **Step 6: Run focused tests**

```bash
node --import tsx --test tests/extract.test.ts tests/asset-mask.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/image/extract.ts src/image/asset-mask.ts tests/extract.test.ts tests/asset-mask.test.ts
git commit -m "feat: gate transparent icon extraction"
```

---

### Task 6: Validate Icon Recompositions Against the Source

**Files:**
- Create: `src/image/recompose.ts`
- Create: `tests/recompose.test.ts`
- Modify: `src/contracts.ts`

**Interfaces:**
- Consumes: original source, candidate background, transparent asset, candidate bbox, and optional ignored OCR mask.
- Produces: `validateRecomposition(options): Promise<RecompositionResult>`.

- [ ] **Step 1: Write failing good/bad recomposition tests**

Create `tests/recompose.test.ts` with two exact synthetic examples:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import { validateRecomposition } from "../src/image/recompose.js";

async function creamCanvas(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: "#f7f3e9",
    },
  }).png().toBuffer();
}

async function blueAsset(background: string): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background,
    },
  }).png().toBuffer();
}

test("accepts an icon that reconstructs the source within threshold", async () => {
  const background = await creamCanvas();
  const asset = await blueAsset("#23394d");
  const source = await sharp(background)
    .composite([{ input: asset, left: 10, top: 8 }])
    .png()
    .toBuffer();
  const result = await validateRecomposition({
    source,
    background,
    asset,
    bbox: { x: 10, y: 8, width: 8, height: 8 },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.metrics.meanAbsoluteError, 0);
  assert.equal(result.metrics.p95ChannelDelta, 0);
  assert.equal(result.metrics.changedPixelRatio, 0);
});

test("rejects a rectangular or hallucinated reconstruction", async () => {
  const background = await creamCanvas();
  const correct = await blueAsset("#23394d");
  const source = await sharp(background)
    .composite([{ input: correct, left: 10, top: 8 }])
    .png()
    .toBuffer();
  const wrong = await blueAsset("#ffffff");
  const result = await validateRecomposition({
    source,
    background,
    asset: wrong,
    bbox: { x: 10, y: 8, width: 8, height: 8 },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "recomposition_mismatch");
  assert.ok(result.metrics.p95ChannelDelta > 12);
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node --import tsx --test tests/recompose.test.ts
```

Expected: FAIL because `src/image/recompose.ts` is missing.

- [ ] **Step 3: Add recomposition result types**

Add to `src/contracts.ts`:

```ts
export type RecompositionOptions = {
  source: Buffer;
  background: Buffer;
  asset: Buffer;
  bbox: BBox;
  ignoredMask?: Buffer;
};

export type RecompositionMetrics = {
  comparedPixels: number;
  meanAbsoluteError: number;
  p95ChannelDelta: number;
  changedPixelRatio: number;
};

export type RecompositionResult = {
  accepted: boolean;
  preview: Buffer;
  metrics: RecompositionMetrics;
  reason?: "recomposition_mismatch";
};
```

- [ ] **Step 4: Implement the validator**

Create `src/image/recompose.ts` using Sharp composite for the preview and raw RGB comparison for metrics:

```ts
import sharp from "sharp";
import type {
  RecompositionOptions,
  RecompositionResult,
} from "../contracts.js";

const MAX_MEAN_ABSOLUTE_ERROR = 3;
const MAX_P95_CHANNEL_DELTA = 12;
const MAX_CHANGED_PIXEL_RATIO = 0.02;
const CHANGED_PIXEL_DELTA = 24;

export async function validateRecomposition(
  options: RecompositionOptions,
): Promise<RecompositionResult> {
  const sourceRaw = await sharp(options.source)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const backgroundRaw = await sharp(options.background)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    sourceRaw.info.width !== backgroundRaw.info.width ||
    sourceRaw.info.height !== backgroundRaw.info.height
  ) {
    throw new Error("Recomposition images must have equal dimensions");
  }
  const left = Math.floor(options.bbox.x);
  const top = Math.floor(options.bbox.y);
  const preview = await sharp(options.background)
    .composite([{ input: options.asset, left, top }])
    .png()
    .toBuffer();
  const previewRaw = await sharp(preview)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ignored = options.ignoredMask === undefined
    ? undefined
    : await sharp(options.ignoredMask)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
  if (
    ignored !== undefined &&
    (ignored.info.width !== sourceRaw.info.width ||
      ignored.info.height !== sourceRaw.info.height)
  ) {
    throw new Error("Ignored mask dimensions do not match source");
  }

  const width = sourceRaw.info.width;
  const height = sourceRaw.info.height;
  const startX = Math.max(0, left - 4);
  const startY = Math.max(0, top - 4);
  const endX = Math.min(width, Math.ceil(left + options.bbox.width + 4));
  const endY = Math.min(height, Math.ceil(top + options.bbox.height + 4));
  const maxDeltas: number[] = [];
  let totalChannelDelta = 0;
  let changedPixels = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const pixelIndex = y * width + x;
      if (
        ignored !== undefined &&
        ignored.data[pixelIndex * ignored.info.channels]! >= 128
      ) {
        continue;
      }
      const offset = pixelIndex * 3;
      const deltas = [0, 1, 2].map((channel) =>
        Math.abs(
          sourceRaw.data[offset + channel]! -
          previewRaw.data[offset + channel]!,
        ),
      );
      const maximum = Math.max(...deltas);
      totalChannelDelta += deltas[0]! + deltas[1]! + deltas[2]!;
      maxDeltas.push(maximum);
      if (maximum > CHANGED_PIXEL_DELTA) changedPixels += 1;
    }
  }
  if (maxDeltas.length === 0) {
    throw new Error("Recomposition comparison region is empty");
  }
  maxDeltas.sort((leftValue, rightValue) => leftValue - rightValue);
  const comparedPixels = maxDeltas.length;
  const metrics = {
    comparedPixels,
    meanAbsoluteError: totalChannelDelta / (comparedPixels * 3),
    p95ChannelDelta:
      maxDeltas[Math.min(maxDeltas.length - 1, Math.floor(maxDeltas.length * 0.95))]!,
    changedPixelRatio: changedPixels / comparedPixels,
  };
  const accepted =
    metrics.meanAbsoluteError <= MAX_MEAN_ABSOLUTE_ERROR &&
    metrics.p95ChannelDelta <= MAX_P95_CHANNEL_DELTA &&
    metrics.changedPixelRatio <= MAX_CHANGED_PIXEL_RATIO;
  return {
    accepted,
    preview,
    metrics,
    ...(accepted ? {} : { reason: "recomposition_mismatch" as const }),
  };
}
```

Compare only the candidate bbox expanded by 4 pixels and skip pixels where `ignoredMask >= 128`. Calculate each pixel's maximum RGB channel delta, the arithmetic mean of all channel deltas, p95 of maximum deltas, and ratio whose maximum delta exceeds 24. Accept only when all three thresholds pass.

- [ ] **Step 5: Run focused tests**

```bash
node --import tsx --test tests/recompose.test.ts
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/contracts.ts src/image/recompose.ts tests/recompose.test.ts
git commit -m "feat: validate icon recomposition fidelity"
```

---

### Task 7: Orchestrate Text-Required and Icon-Optional Fidelity Builds

**Files:**
- Create: `src/fidelity/build.ts`
- Create: `tests/fidelity-build.test.ts`
- Modify: `src/contracts.ts`
- Modify: `src/pipeline.ts`
- Modify: `tests/pipeline.test.ts`
- Modify: `src/export/pptx.ts`
- Modify: `tests/pptx.test.ts`

**Interfaces:**
- Consumes: source PNG and `FidelityPlan`.
- Produces: `buildFidelityLayers(source, plan, dependencies?): Promise<FidelityBuildResult>`.
- Pipeline output: background PNG, manifest v1 containing only accepted text and transparent icons, combined accepted mask, asset buffers, and ledger v2 decisions.

- [ ] **Step 1: Add fidelity decision schemas**

Add to `src/contracts.ts`:

```ts
export const CandidateDecisionSchema = z.object({
  candidateId: z.string().min(1),
  kind: z.enum(["text", "icon"]),
  decision: z.enum(["accepted", "kept_in_background"]),
  bbox: BBoxSchema,
  sourceElementIndexes: z.array(z.number().int().nonnegative()),
  repairMethod: z.enum(["local_nearest_surface", "none"]),
  extraction: z.enum(["transparent", "none"]),
  reason: z.enum([
    "edge_colors_inconsistent",
    "filled_pixels_too_different",
    "local_repair_failed",
    "mask_empty",
    "opaque_border_ratio_above_2_percent",
    "ocr_text_overlap_above_1_percent",
    "recomposition_mismatch",
    "surface_samples_insufficient",
    "surface_variance_too_high",
    "transparent_extraction_failed",
    "transparent_pixel_ratio_above_92_percent",
    "transparent_pixel_ratio_below_5_percent",
  ]).optional(),
  repairMetrics: z.object({
    maskedPixels: z.number().int().nonnegative(),
    outsideMaskChangedPixels: z.number().int().nonnegative(),
    ringSamples: z.number().int().nonnegative(),
    ringChannelMad: z.number().nonnegative(),
    filledPixelDistanceP95: z.number().nonnegative(),
  }).optional(),
  recompositionMetrics: z.object({
    comparedPixels: z.number().int().nonnegative(),
    meanAbsoluteError: z.number().nonnegative(),
    p95ChannelDelta: z.number().nonnegative(),
    changedPixelRatio: z.number().min(0).max(1),
  }).optional(),
  output: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("editable_layer"),
      manifestElementId: z.string().min(1),
      assetPath: z.string().min(1).optional(),
    }),
    z.object({ state: z.literal("kept_in_background") }),
  ]),
});

export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;

export const RunLedgerV2Schema = z.object({
  ledgerVersion: z.literal(2),
  mode: z.enum(["live", "replay"]),
  recorded: z.boolean(),
  models: z.object({
    ocr: z.string().min(1),
    vision: z.string().min(1),
    edit: z.string().min(1).optional(),
  }),
  durationsMs: z.object({
    ocr: z.number().finite().nonnegative(),
    vision: z.number().finite().nonnegative(),
    analyze: z.number().finite().nonnegative(),
    plan: z.number().finite().nonnegative(),
    repair: z.number().finite().nonnegative(),
    export: z.number().finite().nonnegative(),
    total: z.number().finite().nonnegative(),
  }),
  taskIds: z.object({
    wanx: z.string().min(1).optional(),
  }).strict(),
  warnings: z.array(z.string()),
  decisions: z.array(CandidateDecisionSchema),
  hashes: z.object({
    sourceImage: Sha256Schema,
    ocr: Sha256Schema,
    vision: Sha256Schema,
    analysisLedger: Sha256Schema,
    manifest: Sha256Schema,
    removalMask: Sha256Schema,
    cleanBackground: Sha256Schema,
    assets: z.record(z.string(), Sha256Schema),
    pptx: Sha256Schema,
  }),
  outputs: z.object({
    directory: z.string().min(1),
    ocr: z.string().min(1),
    vision: z.string().min(1),
    analysisLedger: z.string().min(1),
    manifest: z.string().min(1),
    removalMask: z.string().min(1),
    cleanBackground: z.string().min(1),
    assets: z.string().min(1),
    pptx: z.string().min(1),
  }),
});

export type RunLedgerV2 = z.infer<typeof RunLedgerV2Schema>;
```

Move the existing private `Sha256Schema` from `src/pipeline.ts` into `src/contracts.ts` and export it so the ledger schema and pipeline share one hash contract. `taskIds` accepts an optional Wanx ID for explicitly requested legacy runs, but the default fidelity path writes `{}`. Parse the final object with `RunLedgerV2Schema` before writing it.

- [ ] **Step 2: Write orchestration tests before implementation**

Create `tests/fidelity-build.test.ts` with dependency injection so no network is used:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

import type { FidelityPlan, TextSlideElement } from "../src/contracts.js";
import {
  buildFidelityLayers,
  type FidelityBuildDependencies,
} from "../src/fidelity/build.js";

const repairMetrics = {
  maskedPixels: 4,
  outsideMaskChangedPixels: 0,
  ringSamples: 20,
  ringChannelMad: 1,
  filledPixelDistanceP95: 2,
};

const recompositionMetrics = {
  comparedPixels: 100,
  meanAbsoluteError: 0,
  p95ChannelDelta: 0,
  changedPixelRatio: 0,
};

function textElement(id: string, y: number): TextSlideElement {
  return {
    kind: "text",
    id,
    text: id,
    bbox: { x: 20, y, width: 100, height: 24 },
    rotation: 0,
    color: "23394D",
    fontSizePx: 18,
    align: "left",
    zIndex: 100,
  };
}

function makePlan(iconCount = 2): FidelityPlan {
  const first = textElement("ocr-1", 20);
  const second = textElement("ocr-2", 60);
  return {
    canvas: { width: 1280, height: 720 },
    text: [first, second].map((element) => ({
      kind: "text" as const,
      id: element.id,
      required: true as const,
      element,
    })),
    icons: Array.from({ length: iconCount }, (_, index) => ({
      kind: "icon" as const,
      id: `icon-${index + 1}`,
      label: `icon ${index + 1}`,
      bbox: { x: 200 + index * 100, y: 200, width: 40, height: 40 },
      zIndex: 2 + index,
      sourceElementIndexes: [index],
    })),
    warnings: [],
  };
}

async function fixtures() {
  const source = await sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 4,
      background: "#f7f3e9",
    },
  }).png().toBuffer();
  const mask = await sharp({
    create: {
      width: 1280,
      height: 720,
      channels: 1,
      background: "#000000",
    },
  }).png().toBuffer();
  const transparentAsset = await sharp({
    create: {
      width: 56,
      height: 56,
      channels: 4,
      background: "#23394d",
    },
  }).png().toBuffer();
  return { source, mask, transparentAsset };
}

function passingDependencies(
  source: Buffer,
  mask: Buffer,
  transparentAsset: Buffer,
): FidelityBuildDependencies {
  return {
    buildTextMask: async () => ({
      mask,
      maskedPixels: 4,
      surfaceRgb: [247, 243, 233],
    }),
    repair: async () => ({
      image: source,
      accepted: true,
      metrics: repairMetrics,
    }),
    extract: async () => ({
      image: transparentAsset,
      extraction: "transparent",
      metrics: {
        transparentRatio: 0.75,
        opaqueBorderRatio: 0,
        foregroundPixels: 64,
      },
    }),
    buildAssetMask: async () => mask,
    validateRecomposition: async () => ({
      accepted: true,
      preview: source,
      metrics: recompositionMetrics,
    }),
  };
}

test("accepts every required text and only a passing transparent icon", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  let extractionCalls = 0;
  dependencies.extract = async () => {
    extractionCalls += 1;
    return extractionCalls === 1
      ? {
          image: transparentAsset,
          extraction: "transparent" as const,
          metrics: {
            transparentRatio: 0.75,
            opaqueBorderRatio: 0,
            foregroundPixels: 64,
          },
        }
      : {
          image: transparentAsset,
          extraction: "rectangular" as const,
          metrics: {
            transparentRatio: 0,
            opaqueBorderRatio: 1,
            foregroundPixels: 56 * 56,
          },
          fallbackReason: "edge_colors_inconsistent" as const,
        };
  };
  const result = await buildFidelityLayers(
    source,
    makePlan(2),
    dependencies,
  );
  assert.equal(result.manifest.elements.filter((item) => item.kind === "text").length, 2);
  assert.equal(result.manifest.elements.filter((item) => item.kind === "asset").length, 1);
  assert.equal(result.manifest.elements.some((item) => item.kind === "shape"), false);
  assert.equal(result.decisions.length, 4);
  assert.equal(result.assets.size, 1);
});

test("fails the page when a required text repair is rejected", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  dependencies.repair = async () => ({
    image: source,
    accepted: false,
    reason: "surface_variance_too_high",
    metrics: repairMetrics,
  });
  await assert.rejects(
    buildFidelityLayers(source, makePlan(0), dependencies),
    /Required text ocr-1 could not be repaired safely/,
  );
});

test("keeps a failed icon in the background and continues", async () => {
  const { source, mask, transparentAsset } = await fixtures();
  const dependencies = passingDependencies(source, mask, transparentAsset);
  dependencies.validateRecomposition = async () => ({
    accepted: false,
    preview: source,
    reason: "recomposition_mismatch",
    metrics: { ...recompositionMetrics, p95ChannelDelta: 80 },
  });
  const result = await buildFidelityLayers(
    source,
    makePlan(1),
    dependencies,
  );
  assert.equal(result.manifest.elements.some((item) => item.kind === "asset"), false);
  assert.deepEqual(result.background, source);
  assert.equal(result.decisions.at(-1)?.decision, "kept_in_background");
});

test("extracts icons from the source and rejects destructive OCR overlap", async () => {
  const { source, transparentAsset } = await fixtures();
  const rawMask = Buffer.alloc(1280 * 720);
  rawMask[200 * 1280 + 200] = 255;
  const overlapMask = await sharp(rawMask, {
    raw: { width: 1280, height: 720, channels: 1 },
  }).png().toBuffer();
  const dependencies = passingDependencies(
    source,
    overlapMask,
    transparentAsset,
  );
  let extractionInput: Buffer | undefined;
  dependencies.extract = async (input) => {
    extractionInput = input;
    return {
      image: transparentAsset,
      extraction: "transparent",
      metrics: {
        transparentRatio: 0.75,
        opaqueBorderRatio: 0,
        foregroundPixels: 64,
      },
    };
  };
  const result = await buildFidelityLayers(
    source,
    makePlan(1),
    dependencies,
  );
  assert.deepEqual(extractionInput, source);
  assert.equal(result.manifest.elements.some((item) => item.kind === "asset"), false);
  assert.equal(
    result.decisions.at(-1)?.reason,
    "ocr_text_overlap_above_1_percent",
  );
});
```

- [ ] **Step 3: Run tests and verify RED**

```bash
node --import tsx --test tests/fidelity-build.test.ts
```

Expected: FAIL because `src/fidelity/build.ts` is missing.

- [ ] **Step 4: Implement the fidelity orchestrator**

Create `src/fidelity/build.ts` with explicit injectable dependencies:

```ts
export type FidelityBuildDependencies = {
  buildTextMask: typeof buildTightTextMask;
  repair: typeof repairLocalRegion;
  extract: typeof extractAsset;
  buildAssetMask: typeof buildAssetRemovalMask;
  validateRecomposition: typeof validateRecomposition;
};

export type FidelityBuildResult = {
  background: Buffer;
  combinedMask: Buffer;
  manifest: SlideManifest;
  assets: Map<string, Buffer>;
  decisions: CandidateDecision[];
};
```

Processing order and rollback semantics must be implemented exactly:

```ts
function expandAndClip(
  bbox: BBox,
  padding: number,
  canvas: { width: number; height: number },
): BBox {
  const x = Math.max(0, Math.floor(bbox.x - padding));
  const y = Math.max(0, Math.floor(bbox.y - padding));
  const right = Math.min(canvas.width, Math.ceil(bbox.x + bbox.width + padding));
  const bottom = Math.min(canvas.height, Math.ceil(bbox.y + bbox.height + padding));
  return { x, y, width: right - x, height: bottom - y };
}

async function orMasks(
  masks: readonly Buffer[],
  canvas: { width: number; height: number },
): Promise<Buffer> {
  const output = Buffer.alloc(canvas.width * canvas.height);
  for (const mask of masks) {
    const { data, info } = await sharp(mask)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== canvas.width || info.height !== canvas.height) {
      throw new Error("Candidate mask dimensions do not match the canvas");
    }
    for (let index = 0; index < output.length; index += 1) {
      output[index] = Math.max(output[index]!, data[index * 3]!);
    }
  }
  return sharp(output, {
    raw: { width: canvas.width, height: canvas.height, channels: 1 },
  }).png().toBuffer();
}

async function maskOverlapRatio(
  candidateMask: Buffer,
  protectedTextMask: Buffer,
): Promise<number> {
  const [candidate, protectedText] = await Promise.all(
    [candidateMask, protectedTextMask].map((input) =>
      sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  if (
    candidate.info.width !== protectedText.info.width ||
    candidate.info.height !== protectedText.info.height
  ) {
    throw new Error("Candidate and protected-text masks must have equal dimensions");
  }
  let foreground = 0;
  let overlap = 0;
  for (let index = 0; index < candidate.info.width * candidate.info.height; index += 1) {
    const candidateOn = candidate.data[index * candidate.info.channels]! >= 128;
    if (!candidateOn) continue;
    foreground += 1;
    if (protectedText.data[index * protectedText.info.channels]! >= 128) overlap += 1;
  }
  return foreground === 0 ? 0 : overlap / foreground;
}

let background = source;
const acceptedElements: SlideElement[] = [];
const decisions: CandidateDecision[] = [];
const assets = new Map<string, Buffer>();
const acceptedMasks: Buffer[] = [];
const acceptedTextMasks: Buffer[] = [];

for (const candidate of plan.text) {
  const mask = await dependencies.buildTextMask(source, candidate.element);
  const repaired = await dependencies.repair(background, mask.mask);
  if (!repaired.accepted || repaired.metrics.outsideMaskChangedPixels !== 0) {
    throw new Error(`Required text ${candidate.id} could not be repaired safely`);
  }
  background = repaired.image;
  acceptedMasks.push(mask.mask);
  acceptedTextMasks.push(mask.mask);
  acceptedElements.push(candidate.element);
  decisions.push({
    candidateId: candidate.id,
    kind: "text",
    decision: "accepted",
    bbox: candidate.element.bbox,
    sourceElementIndexes: [],
    repairMethod: "local_nearest_surface",
    extraction: "none",
    repairMetrics: repaired.metrics,
    output: {
      state: "editable_layer",
      manifestElementId: candidate.element.id,
    },
  });
}

const acceptedTextMask = await orMasks(acceptedTextMasks, plan.canvas);
for (const candidate of plan.icons) {
  const bbox = expandAndClip(candidate.bbox, 8, plan.canvas);
  const extracted = await dependencies.extract(source, bbox, {
    extraction: "transparent",
  });
  if (extracted.extraction !== "transparent") {
    decisions.push({
      candidateId: candidate.id,
      kind: "icon",
      decision: "kept_in_background",
      bbox,
      sourceElementIndexes: candidate.sourceElementIndexes,
      repairMethod: "none",
      extraction: "none",
      reason: extracted.fallbackReason ?? "transparent_extraction_failed",
      output: { state: "kept_in_background" },
    });
    continue;
  }
  const mask = await dependencies.buildAssetMask(
    extracted.image,
    bbox,
    plan.canvas,
  );
  if ((await maskOverlapRatio(mask, acceptedTextMask)) > 0.01) {
    decisions.push({
      candidateId: candidate.id,
      kind: "icon",
      decision: "kept_in_background",
      bbox,
      sourceElementIndexes: candidate.sourceElementIndexes,
      repairMethod: "none",
      extraction: "transparent",
      reason: "ocr_text_overlap_above_1_percent",
      output: { state: "kept_in_background" },
    });
    continue;
  }
  const repaired = await dependencies.repair(background, mask);
  if (!repaired.accepted) {
    decisions.push({
      candidateId: candidate.id,
      kind: "icon",
      decision: "kept_in_background",
      bbox,
      sourceElementIndexes: candidate.sourceElementIndexes,
      repairMethod: "local_nearest_surface",
      extraction: "transparent",
      reason: repaired.reason ?? "local_repair_failed",
      repairMetrics: repaired.metrics,
      output: { state: "kept_in_background" },
    });
    continue;
  }
  const recomposed = await dependencies.validateRecomposition({
    source,
    background: repaired.image,
    asset: extracted.image,
    bbox,
    ignoredMask: acceptedTextMask,
  });
  if (!recomposed.accepted) {
    decisions.push({
      candidateId: candidate.id,
      kind: "icon",
      decision: "kept_in_background",
      bbox,
      sourceElementIndexes: candidate.sourceElementIndexes,
      repairMethod: "local_nearest_surface",
      extraction: "transparent",
      reason: recomposed.reason,
      repairMetrics: repaired.metrics,
      recompositionMetrics: recomposed.metrics,
      output: { state: "kept_in_background" },
    });
    continue;
  }
  background = repaired.image;
  acceptedMasks.push(mask);
  const assetPath = `assets/${candidate.id}.png`;
  assets.set(assetPath, extracted.image);
  acceptedElements.push({
    kind: "asset",
    id: candidate.id,
    label: candidate.label,
    bbox,
    extraction: "transparent",
    assetPath,
    zIndex: candidate.zIndex,
  });
  decisions.push({
    candidateId: candidate.id,
    kind: "icon",
    decision: "accepted",
    bbox,
    sourceElementIndexes: candidate.sourceElementIndexes,
    repairMethod: "local_nearest_surface",
    extraction: "transparent",
    repairMetrics: repaired.metrics,
    recompositionMetrics: recomposed.metrics,
    output: {
      state: "editable_layer",
      manifestElementId: candidate.id,
      assetPath,
    },
  });
}

const combinedMask = await orMasks(acceptedMasks, plan.canvas);
const manifest = SlideManifestSchema.parse({
  manifestVersion: 1,
  canvas: plan.canvas,
  elements: acceptedElements.sort(
    (left, right) => left.zIndex - right.zIndex,
  ),
  warnings: plan.warnings,
});
return { background, combinedMask, manifest, assets, decisions };
```

The combined mask is the pixelwise OR of accepted text and accepted icon masks. Do not include rejected icon masks.

- [ ] **Step 5: Convert `buildFromAnalysis` to fidelity output**

Modify `src/pipeline.ts`:

1. Replace `planSlide(...)`, combined `buildRemovalMask(...)`, and default `inpaintBackground(...)` with `planFidelityCandidates(...)` and `buildFidelityLayers(...)`.
2. Write only accepted assets from `FidelityBuildResult.assets`.
3. Write `clean-background.png` from `result.background`.
4. Write `removal-mask.png` from `result.combinedMask`.
5. Write manifest with zero structural shapes in the fidelity path.
6. Write ledger v2 with `decisions`, `durationsMs.repair`, empty `taskIds`, and the existing hashes/outputs.
7. Preserve existing staging, ownership marker, failed-run retention, replay provenance, and atomic promotion code unchanged.

Add one build-level injection seam so pipeline orchestration tests stay deterministic while `tests/fidelity-build.test.ts` exercises the real builder:

```ts
export type FidelityBuild = typeof buildFidelityLayers;

export type RunPipelineOptions = {
  imagePath: string;
  outDir: string;
  replay?: ReplayInputs;
  record?: boolean;
  config?: AppConfig;
  fidelityBuild?: FidelityBuild;
};

export type BuildOptions = {
  imagePath: string;
  analysisDir: string;
  outDir: string;
  config?: AppConfig;
  fidelityBuild?: FidelityBuild;
};
```

Inside `buildFromAnalysis`, call `(options.fidelityBuild ?? buildFidelityLayers)(image, fidelityPlan)` exactly once.

Remove default invocation of `inpaintBackground` from `buildFromAnalysis`. Keep `src/providers/wanx-edit.ts` and its tests as an isolated optional provider; it must not run in `scripts/accept-slide-07.sh`.

- [ ] **Step 6: Harden export against rectangular fidelity assets**

At the beginning of `exportPptx` add:

```ts
for (const element of manifest.elements) {
  if (element.kind === "asset" && element.extraction !== "transparent") {
    throw new Error(`Refusing to export rectangular fidelity asset ${element.id}`);
  }
}
```

Update `tests/pptx.test.ts` so the regular export fixture uses only transparent assets, and add a rejection test for one rectangular asset.

- [ ] **Step 7: Update pipeline tests to the new contract**

In `tests/pipeline.test.ts`, replace the old expectations:

```ts
assert.equal(nativeShapeLabels.length, 0);
assert.equal(
  manifest.elements.filter((element) => element.kind === "text").length,
  10,
);
assert.ok(
  manifest.elements
    .filter((element) => element.kind === "asset")
    .every((element) => element.extraction === "transparent"),
);
assert.equal(ledger.ledgerVersion, 2);
assert.equal(ledger.taskIds.wanx, undefined);
assert.equal(ledger.decisions.filter((item) => item.kind === "text").length, 10);
```

Inject `fidelityBuild` at the `runPipeline` boundary in pipeline orchestration tests and return a deterministic manifest, background, combined mask, decision list, and asset map. Keep the real fidelity algorithm covered by `tests/fidelity-build.test.ts`. Do not reintroduce a fake Wanx result merely to satisfy the old test.

- [ ] **Step 8: Run focused and full offline gates**

```bash
node --import tsx --test tests/fidelity-build.test.ts tests/pipeline.test.ts tests/pptx.test.ts
npm test
npm run lint:types
npm run build
npm run test:compiled
```

Expected: all source and compiled tests pass; typecheck and build exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/contracts.ts src/fidelity/build.ts src/pipeline.ts src/export/pptx.ts tests/fidelity-build.test.ts tests/pipeline.test.ts tests/pptx.test.ts
git commit -m "feat: build fidelity-first editable slides"
```

---

### Task 8: Document and Run the Real Slide 7 Acceptance

**Files:**
- Modify: `README.md`
- Modify: `scripts/accept-slide-07.sh`
- Modify: `tests/accept-script.test.ts`
- Runtime output: `output/slide-07/`

**Interfaces:**
- Consumes: `.env` with `DASHSCOPE_API_KEY` and `DASHSCOPE_WORKSPACE_ID` plus the inspected slide 7 PNG.
- Produces: live analysis, fidelity background, accepted transparent assets, editable PPTX, ledger v2, render, and human QA result.

- [ ] **Step 1: Update documentation tests first**

Extend `tests/accept-script.test.ts` to assert the acceptance script does not reference `wanx`, `inpaint`, or `DASHSCOPE_EDIT_MODEL`, and still preflights both credentials before invoking npm.

Add a README contract test only if the repository already has README tests; otherwise verify exact text with `rg` in Step 5.

- [ ] **Step 2: Run the acceptance-script test and verify RED**

```bash
node --import tsx --test tests/accept-script.test.ts
```

Expected: FAIL until the script and assertions describe the fidelity path.

- [ ] **Step 3: Update README and the script**

README must state:

- a complete run sends the source image to OCR and Vision only;
- Wanx is not part of default slide 7 acceptance;
- panel/bar/texture furniture remains in the background;
- ten OCR texts are required;
- icons may be kept in the background;
- rectangular assets cannot be published;
- ledger v2 contains per-candidate decisions and metrics;
- the prior ¥0.20–¥0.50 budget is replaced with a current-pricing disclaimer for one OCR plus one Vision request, without inventing a fixed price.

Keep `scripts/accept-slide-07.sh` as:

```bash
exec npm run cli -- run --image "$SLIDE_IMAGE" --out output/slide-07 --record
```

No background-model flag or Wanx environment variable is allowed.

- [ ] **Step 4: Run the complete offline gate before spending API credits**

```bash
npm test
npm run lint:types
npm run build
npm run test:compiled
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Run one live slide 7 acceptance**

```bash
set -a
source .env
set +a
bash scripts/accept-slide-07.sh
```

Expected: exit 0, no Wanx task ID, and output at `output/slide-07`.

Verify the output contract:

```bash
jq -e '.ledgerVersion == 2' output/slide-07/run-ledger.json
jq -e '[.elements[] | select(.kind == "text")] | length == 10' output/slide-07/manifest.json
jq -e '[.elements[] | select(.kind == "shape")] | length == 0' output/slide-07/manifest.json
jq -e '[.elements[] | select(.kind == "asset" and .extraction != "transparent")] | length == 0' output/slide-07/manifest.json
jq -e '[.decisions[] | select(.kind == "text" and .decision == "accepted")] | length == 10' output/slide-07/run-ledger.json
```

- [ ] **Step 6: Render and inspect the final PPTX**

Use the bundled presentation runtime paths returned by `load_workspace_dependencies`, then run:

```bash
"$RUNTIME_PYTHON" "$SKILL_DIR/container_tools/render_slides.py" \
  output/slide-07/slide-07-editable.pptx \
  --output_dir .codex-tmp/fidelity-slide-07/rendered

"$RUNTIME_PYTHON" "$SKILL_DIR/container_tools/slides_test.py" \
  output/slide-07/slide-07-editable.pptx
```

Expected: one rendered slide and `Test passed. No overflow detected.`

Inspect the source and final render full-size. Fail acceptance if any of these are visible:

- duplicated source text beneath editable text;
- generated or residual pseudo-text;
- new objects or web-like structure;
- rectangular icon backgrounds;
- damaged panel/bar boundaries;
- obvious local-repair seams.

- [ ] **Step 7: Perform editable-layer smoke in PowerPoint or WPS**

Open `output/slide-07/slide-07-editable.pptx` and:

1. Change the title text.
2. Change the bottom slogan.
3. If at least one icon was accepted, move it 20–30 pixels and confirm the background underneath is clean.
4. Undo the edits and save only if the user wants the smoke-edited copy retained.

Record the observed result in the task handoff; do not claim this step from render evidence alone.

- [ ] **Step 8: Commit documentation and acceptance updates**

```bash
git add README.md scripts/accept-slide-07.sh tests/accept-script.test.ts
git commit -m "docs: define fidelity-first slide acceptance"
```

- [ ] **Step 9: Final branch verification**

```bash
git status --short
git log --oneline --decorate -8
npm test
npm run lint:types
npm run build
npm run test:compiled
```

Expected: no uncommitted implementation files, all gates pass, and the live output is explicitly reported separately from Git status.
