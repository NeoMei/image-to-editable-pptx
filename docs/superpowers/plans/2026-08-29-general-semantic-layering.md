# General Semantic Layering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade image-to-editable-pptx into a generic, fidelity-first semantic layering pipeline for bounded PNG/JPEG inputs, with editable OCR text, movable foreground objects, text-backing layers, selective occlusion completion, arbitrary aspect-ratio PPTX export, and auditable QA artifacts.

**Architecture:** Decode every accepted input into one canonical RGBA canvas, describe it with a normalized semantic scene graph, refine only ambiguous subgraphs, then build candidates through deterministic mask extraction and strict rollback gates. Network work ends in analyze; build consumes a hash-verified self-contained package and remains offline. Accepted layers and text are exported through one canvas-to-slide transform, while uncertain pixels remain in the background.

**Tech Stack:** Node.js 22.6+, TypeScript 5.9, Zod 4, Sharp 0.35, OpenAI-compatible Alibaba Qwen OCR/Vision APIs, Alibaba Wanx image-edit provider, PptxGenJS 4, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-29-general-semantic-layering-design.md`

## Global Constraints

- Do not branch on model labels, slide number, acceptance-fixture coordinates, object names, or exact colors.
- Do not send network requests from build or from any export helper.
- Extract all visible pixels from the original canonical RGBA canvas; generated pixels may fill only an explicit hidden-region mask.
- Treat every candidate atomically: rejected candidates contribute neither an asset nor pixels to the final removal mask.
- Preserve manifest v1 reading while emitting manifest v2 for all new builds.
- Keep current output ownership, atomic publication, recursive redaction, 0600 recording permissions, and failed-run retention behavior.
- Add tests before implementation in every task and commit only after its focused tests pass.

---

### Task 1: Introduce a bounded canonical source-canvas contract

**Files:**
- Create: `src/image/source.ts`
- Create: `tests/source-image.test.ts`
- Modify: `src/pipeline.ts`
- Modify: `tests/pipeline.test.ts`

**Interfaces:**

~~~ts
export type SourceFormat = "png" | "jpeg";

export type SourceCanvas = {
  format: SourceFormat;
  width: number;
  height: number;
  rgba: Buffer;
  sourceBytes: Buffer;
};

export async function decodeSourceImage(path: string): Promise<SourceCanvas>;
export function assertSupportedCanvas(width: number, height: number): void;
~~~

- [ ] Add failing tests that accept real PNG and JPEG fixtures, accept a valid image with a misleading extension, and reject unsupported magic bytes, corrupt input, files over 50 MiB, dimensions outside 64–8192, more than 40,000,000 pixels, and aspect ratios above 56:1.

~~~ts
await assert.rejects(
  decodeSourceImage("tests/fixtures/source-63x720.png"),
  /at least 64 pixels/,
);
await assert.rejects(
  decodeSourceImage("tests/fixtures/source-8192x8192.png"),
  /40,000,000 pixels/,
);
~~~

- [ ] Run `node --import tsx --test tests/source-image.test.ts tests/pipeline.test.ts`; expect failures because the pipeline still requires an exact 1280×720 PNG.
- [ ] Implement magic-byte classification and Sharp metadata inspection before full RGBA decode. Set Sharp input limits explicitly, reject animated/multipage input, then return an sRGB, alpha-bearing, raw RGBA buffer of exactly `width * height * 4` bytes.
- [ ] Replace `inspectSourceImage` in the pipeline with `decodeSourceImage`; retain the original bytes for hashing/provider upload and use the canonical RGBA buffer for all local processing.
- [ ] Add a regression assertion that rejection happens before the OCR or Vision stub is invoked.
- [ ] Run the focused tests and `npm run lint:types`; expect all to pass.
- [ ] Commit with `git add src/image/source.ts src/pipeline.ts tests/source-image.test.ts tests/pipeline.test.ts && git commit -m "feat: support bounded png and jpeg canvases"`.

---

### Task 2: Define dynamic geometry, scene graph, and manifest v2 contracts

**Files:**
- Create: `src/scene/contracts.ts`
- Create: `src/scene/geometry.ts`
- Create: `tests/scene-contracts.test.ts`
- Modify: `src/contracts.ts`
- Modify: `tests/contracts.test.ts`

**Interfaces:**

~~~ts
export type CanvasSize = { width: number; height: number };
export type NormalizedBBox = { x: number; y: number; width: number; height: number };
export type SceneRole =
  | "background" | "text" | "text-backing" | "foreground-object"
  | "connector" | "compound-group" | "decoration";
export type SceneRelationKind =
  | "belongs-to" | "connected-to" | "carries-text"
  | "occludes" | "in-front-of" | "behind";
export type SceneNode = {
  id: string;
  role: SceneRole;
  bbox: NormalizedBBox;
  confidence: number;
  zIndex?: number;
  label: string;
  extractionHints: string[];
};
export type SceneRelation = {
  id: string;
  kind: SceneRelationKind;
  from: string;
  to: string;
  confidence: number;
};
export type SceneGraph = {
  graphVersion: 1;
  canvas: CanvasSize;
  nodes: SceneNode[];
  relations: SceneRelation[];
};
export function toPixelBBox(bbox: NormalizedBBox, canvas: CanvasSize): BBox;
export function createBBoxSchema(canvas: CanvasSize): z.ZodType<BBox>;
~~~

- [ ] Add failing tests for normalized bounds, duplicate node/relation IDs, dangling relation endpoints, background cardinality, invalid carries-text direction, pixel rounding at canvas edges, and graph JSON round trips.
- [ ] Add manifest fixtures proving v1 remains readable and v2 assets require `role`, `groupId`, `provenance`, `relations`, and `reviewRequired`.

~~~ts
const parsed = SlideManifestSchema.parse(v1Fixture);
assert.equal(parsed.manifestVersion, 1);
assert.throws(() => SlideManifestV2Schema.parse(v2WithoutProvenance));
~~~

- [ ] Run `node --import tsx --test tests/contracts.test.ts tests/scene-contracts.test.ts`; expect schema and export failures.
- [ ] Implement strict scene schemas and a graph-level `superRefine`. Keep BBox pixel types dynamic and validate them with the owning canvas rather than global 1280×720 constants.
- [ ] Replace `SlideManifestSchema` with a discriminated v1/v2 union. Define v2 asset provenance as either `source-visible`, `generated-hidden`, or a composition of both with mask hashes and optional provider metadata.
- [ ] Update imports without changing runtime behavior yet; use v1-compatible aliases only where required to keep the intermediate branch compiling.
- [ ] Run focused tests and `npm run lint:types`; expect all to pass.
- [ ] Commit with `git add src/contracts.ts src/scene tests/contracts.test.ts tests/scene-contracts.test.ts && git commit -m "feat: add semantic scene graph contracts"`.

---

### Task 3: Replace flat Vision output with a generic full-slide scene graph

**Files:**
- Create: `src/providers/qwen-scene.ts`
- Create: `tests/qwen-scene.test.ts`
- Create: `tests/fixtures/qwen-scene-generic.json`
- Modify: `src/providers/qwen-vision.ts`
- Modify: `tests/qwen-vision.test.ts`

**Interfaces:**

~~~ts
export async function analyzeScene(
  image: Buffer,
  canvas: CanvasSize,
  config: AppConfig,
  observer?: ProviderResponseObserver,
): Promise<SceneGraph>;

export function parseQwenSceneContent(
  content: string,
  canvas: CanvasSize,
): SceneGraph;
~~~

- [ ] Write parser tests for all roles and relations, fenced JSON, malformed JSON, invalid relation endpoints, out-of-range normalized coordinates, duplicate IDs, and arbitrary canvas dimensions.
- [ ] Add a source-scan test that fails if provider/planner code contains acceptance-specific tokens such as `眼睛`, `雷达`, `扳手`, `盾牌`, `安全机制`, `slide-07`, or literal 1280/720 geometry branches.
- [ ] Run `node --import tsx --test tests/qwen-scene.test.ts tests/qwen-vision.test.ts`; expect the new graph tests to fail.
- [ ] Implement a strict JSON-only prompt describing roles, relations, independent mobility, compound connectivity, text-backing, occlusion, and normalized coordinates. State that OCR is authoritative for text and labels are audit-only.
- [ ] Parse provider coordinates to [0,1], validate the full graph, and preserve `qwen-vision.ts` as a compatibility adapter only for v1 recordings.
- [ ] Verify observer hooks record raw response and parse failure exactly once and never log image data or authorization values.
- [ ] Run focused tests, `npm run lint:types`, and `npm run build`; expect all to pass.
- [ ] Commit with `git add src/providers/qwen-scene.ts src/providers/qwen-vision.ts tests/qwen-scene.test.ts tests/qwen-vision.test.ts tests/fixtures/qwen-scene-generic.json && git commit -m "feat: analyze generic semantic scene graphs"`.

---

### Task 4: Add bounded regional Vision refinement and deterministic graph merging

**Files:**
- Create: `src/scene/refine.ts`
- Create: `tests/scene-refine.test.ts`
- Modify: `src/providers/qwen-scene.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**

~~~ts
export type RefinementRequest = {
  targetNodeIds: string[];
  crop: BBox;
  reason: "compound" | "occlusion" | "conflicting-relations" | "incomplete-boundary";
};
export type RefinementResult = {
  graph: SceneGraph;
  requests: RefinementRequest[];
};
export function selectRefinementRequests(
  graph: SceneGraph,
  canvas: CanvasSize,
  limit: number,
): RefinementRequest[];
export function mergeRefinedSubgraph(
  graph: SceneGraph,
  request: RefinementRequest,
  localGraph: SceneGraph,
): SceneGraph;
~~~

- [ ] Add failing tests for deterministic priority, maximum eight requests, zero disabling refinement, padded crop clamping, local-to-global coordinate mapping, unrelated-node preservation, duplicate replacement, and rejection of a local graph that escapes the requested crop.
- [ ] Add graph fixtures for a split pair, connected compound, nested object, occlusion, and contradictory z-order.
- [ ] Run `node --import tsx --test tests/scene-refine.test.ts tests/config.test.ts`; expect missing-module failures.
- [ ] Implement generic selection from graph properties only. Sort by reason severity, confidence ascending, normalized area descending, then stable node ID so replay is deterministic.
- [ ] Add `maxRegionAnalysis` to `AppConfig` with default 8 and strict integer range 0–8.
- [ ] Implement regional prompt invocation using a minimal padded crop and merge only the requested target subgraph. Revalidate the complete graph after each accepted merge; preserve the pre-refinement graph on invalid output and append a warning.
- [ ] Run focused tests and `npm run lint:types`; expect all to pass.
- [ ] Commit with `git add src/scene/refine.ts src/providers/qwen-scene.ts src/config.ts tests/scene-refine.test.ts tests/config.test.ts && git commit -m "feat: refine ambiguous scene subgraphs"`.

---

### Task 5: Build a relation-aware, label-agnostic layer planner

**Files:**
- Create: `src/scene/plan.ts`
- Create: `tests/scene-plan.test.ts`
- Modify: `src/fidelity/candidates.ts`
- Modify: `tests/fidelity-candidates.test.ts`
- Modify: `src/contracts.ts`

**Interfaces:**

~~~ts
export type SemanticCandidateKind =
  | "foreground-object" | "text-backing" | "compound-group";
export type SemanticCandidate = {
  id: string;
  kind: SemanticCandidateKind;
  nodeIds: string[];
  bbox: BBox;
  zOrder: number;
  relations: string[];
  occlusion?: { occluderIds: string[]; hiddenMaskRequired: true };
};
export type SemanticLayerPlan = {
  canvas: CanvasSize;
  text: FidelityTextCandidate[];
  candidates: SemanticCandidate[];
  backgroundNodeId: string;
  warnings: string[];
};
export function planSemanticLayers(
  graph: SceneGraph,
  ocr: OcrResult,
): SemanticLayerPlan;
~~~

- [ ] Add failing tests that keep adjacent independent nodes separate, combine only explicit compound membership/connected composition, de-duplicate strong geometric duplicates, preserve transitive compound membership, attach carries-text relations, and compute deterministic z-order.
- [ ] Add tests that reject cycles in in-front-of/behind, ambiguous substantial backing/object overlap, dangling OCR associations, and uncertain decoration candidates by leaving them in background with warnings.
- [ ] Run `node --import tsx --test tests/scene-plan.test.ts tests/fidelity-candidates.test.ts`; expect planner failures.
- [ ] Implement a relation graph and topological ordering. Convert behind into the same directed ordering convention as in-front-of; if a cycle touches a candidate, exclude that candidate rather than guessing.
- [ ] Keep the old `planFidelityCandidates` adapter for v1 replay only, and move all new-build candidate decisions to `planSemanticLayers`.
- [ ] Extend candidate decision kinds and reasons without removing v2 ledger compatibility fields used by existing successful runs.
- [ ] Run focused tests, `npm run lint:types`, and the existing planner suite; expect all to pass.
- [ ] Commit with `git add src/scene/plan.ts src/fidelity/candidates.ts src/contracts.ts tests/scene-plan.test.ts tests/fidelity-candidates.test.ts && git commit -m "feat: plan relation-aware semantic layers"`.

---

### Task 6: Generalize deterministic semantic mask extraction

**Files:**
- Create: `src/image/semantic-mask.ts`
- Create: `tests/semantic-mask.test.ts`
- Modify: `src/image/asset-mask.ts`
- Modify: `src/image/extract.ts`
- Modify: `tests/asset-mask.test.ts`
- Modify: `tests/extract.test.ts`

**Interfaces:**

~~~ts
export type MaskCandidate = {
  bbox: BBox;
  mask: Buffer;
  cropPaddingPx: number;
  metrics: {
    foregroundRatio: number;
    opaqueBorderRatio: number;
    antialiasedEdgeRatio: number;
    connectedComponents: number;
    completeness: number;
  };
};
export async function deriveSemanticMasks(
  canvas: SourceCanvas,
  candidate: SemanticCandidate,
): Promise<MaskCandidate[]>;
export function chooseSemanticMask(
  masks: MaskCandidate[],
  unrelatedTextMask: Buffer,
): MaskCandidate | undefined;
~~~

- [ ] Create synthetic fixtures at multiple scales for separate adjacent icons, touching-but-independent icons, connected compounds, antialiased outlines, transparent-looking interiors, gradients, JPEG ringing, and incomplete edge crops.
- [ ] Add failing assertions that independent planned candidates never share pixels, compound candidates retain connectors, padding scales with the shorter canvas side, and JPEG tolerance cannot relax OCR overlap or opaque-border gates.
- [ ] Run `node --import tsx --test tests/semantic-mask.test.ts tests/asset-mask.test.ts tests/extract.test.ts`; expect missing generic extraction behavior.
- [ ] Implement bbox-local edge/color/connected-component proposals from the canonical RGBA canvas. Search bounded padding values derived from canvas scale and candidate size rather than fixed slide coordinates.
- [ ] Preserve soft alpha and decontaminate edge colors. Rank masks by completeness first, then unrelated-text overlap, border opacity, and compactness; reject instead of returning a rectangular crop.
- [ ] Convert existing icon helpers into low-level primitives used by the generic extractor, and keep exact old fixtures passing.
- [ ] Run focused tests, `npm run lint:types`, and `npm run build`; expect all to pass.
- [ ] Commit with `git add src/image/semantic-mask.ts src/image/asset-mask.ts src/image/extract.ts tests/semantic-mask.test.ts tests/asset-mask.test.ts tests/extract.test.ts && git commit -m "feat: extract generic semantic masks"`.

---

### Task 7: Extract text-backing assets and remove their text safely

**Files:**
- Create: `src/fidelity/text-backing.ts`
- Create: `tests/text-backing.test.ts`
- Modify: `src/image/text-mask.ts`
- Modify: `src/image/local-repair.ts`
- Modify: `tests/text-mask.test.ts`
- Modify: `tests/local-repair.test.ts`

**Interfaces:**

~~~ts
export type TextBackingResult = {
  accepted: boolean;
  asset?: Buffer;
  assetMask?: Buffer;
  repairedSource?: Buffer;
  textNodeIds: string[];
  metrics: {
    residualGlyphRatio: number;
    outsideBackingChangedPixels: number;
    seamContrastP95: number;
  };
  reason?: "backing_mask_invalid" | "glyph_residue" | "repair_seam" | "surface_unstable";
};
export async function extractTextBacking(
  canvas: SourceCanvas,
  candidate: SemanticCandidate,
  texts: TextSlideElement[],
): Promise<TextBackingResult>;
~~~

- [ ] Add failing fixtures for solid, gradient, lightly textured, rounded, multiline Chinese/English, and backing shapes next to icons. Add negative fixtures for heavy texture, intersecting unrelated object, incomplete border, and repair seam.
- [ ] Assert that the asset contains the complete backing alpha, contains no OCR glyph pixels above the residual threshold, changes no pixels outside the backing mask, and preserves the editable text separately.
- [ ] Run `node --import tsx --test tests/text-backing.test.ts tests/text-mask.test.ts tests/local-repair.test.ts`; expect the new tests to fail.
- [ ] Build a union of only the carries-text OCR tight masks, clip it to the accepted backing mask, and run same-surface local repair inside the backing asset. Use ring sampling adapted to flat, gradient, and low-variance textured surfaces.
- [ ] Add residual-glyph and seam-contrast gates. On any failure return one rejected result; never emit a partial backing or add its mask to the background-removal union.
- [ ] Ensure unrelated OCR overlap always rejects and no label text influences the algorithm.
- [ ] Run focused tests and `npm run lint:types`; expect all to pass.
- [ ] Commit with `git add src/fidelity/text-backing.ts src/image/text-mask.ts src/image/local-repair.ts tests/text-backing.test.ts tests/text-mask.test.ts tests/local-repair.test.ts && git commit -m "feat: extract editable text backing layers"`.

---

### Task 8: Add provider-neutral, masked occlusion completion

**Files:**
- Create: `src/occlusion/contracts.ts`
- Create: `src/occlusion/complete.ts`
- Create: `tests/occlusion-complete.test.ts`
- Modify: `src/providers/wanx-edit.ts`
- Modify: `tests/wanx-edit.test.ts`
- Modify: `src/config.ts`

**Interfaces:**

~~~ts
export type OcclusionCompletionProvider = {
  complete(request: {
    crop: Buffer;
    hiddenMask: Buffer;
    protectedVisibleMask: Buffer;
    semanticContext: string[];
  }): Promise<{
    image: Buffer;
    modelId: string;
    taskId: string;
    sanitizedMetadata: unknown;
  }>;
};
export type CompletedCandidate = {
  image: Buffer;
  visibleMask: Buffer;
  generatedMask: Buffer;
  reviewRequired: true;
  provenance: AssetProvenance;
};
export async function completeOccludedCandidate(
  input: OcclusionCompletionInput,
  provider: OcclusionCompletionProvider,
): Promise<CompletedCandidate | undefined>;
~~~

- [ ] Add failing tests for absent occludes relation, locally complete contours, visible-pixel modification, writes outside hidden mask, disconnected completed contour, provider error, timeout, zero limit, and a strict maximum of four calls.
- [ ] Add a provider-stub assertion that each request contains only the padded candidate crop and masks, never the full slide.
- [ ] Run `node --import tsx --test tests/occlusion-complete.test.ts tests/wanx-edit.test.ts tests/config.test.ts`; expect failures.
- [ ] Implement a provider-neutral completion gate. Derive hidden regions only from an accepted occlusion relation plus a locally proven truncated contour; preserve all visible RGBA bytes by compositing generated pixels only through the hidden mask.
- [ ] Adapt Wanx to the provider interface, keep compatible-base URL and redirect safety, and return only sanitized task metadata. Add `maxOcclusionCompletions` default 4, range 0–4.
- [ ] Validate generated-mask containment and contour continuity. Any failure returns no completed layer and leaves the original pixels in the background.
- [ ] Record SHA-256 hashes for crop, visible mask, generated mask, and final asset; set `reviewRequired: true` unconditionally for generated hidden pixels.
- [ ] Run focused tests, `npm run lint:types`, and `npm run build`; expect all to pass.
- [ ] Commit with `git add src/occlusion src/providers/wanx-edit.ts src/config.ts tests/occlusion-complete.test.ts tests/wanx-edit.test.ts tests/config.test.ts && git commit -m "feat: complete occluded regions with masked providers"`.

---

### Task 9: Create a self-contained, hash-verified analysis package v2

**Files:**
- Create: `src/analysis/package.ts`
- Create: `tests/analysis-package.test.ts`
- Modify: `src/pipeline.ts`
- Modify: `src/recording.ts`
- Modify: `tests/recording.test.ts`
- Modify: `tests/pipeline.test.ts`

**Interfaces:**

~~~ts
export type AnalysisPackageV2 = {
  analysisVersion: 2;
  canvas: CanvasSize;
  source: { path: "source.rgba"; sha256: string; format: SourceFormat };
  ocr: { path: "ocr.json"; sha256: string };
  scene: { path: "scene-graph.json"; sha256: string };
  refinements: AnalysisArtifact[];
  completions: CompletionArtifact[];
  requests: { ocr: number; fullVision: number; regionalVision: number; completion: number };
};
export type AnalysisArtifact = { path: string; sha256: string; crop?: BBox };
export type CompletionArtifact = AnalysisArtifact & {
  candidateId: string;
  visibleMaskPath: string;
  generatedMaskPath: string;
  reviewRequired: true;
  provenance: AssetProvenance;
};
export async function writeAnalysisPackageV2(input: {
  directory: string;
  canvas: SourceCanvas;
  ocr: OcrResult;
  scene: SceneGraph;
  refinements: AnalysisArtifact[];
  completions: CompletionArtifact[];
  ledger: AnalysisPackageV2;
}): Promise<void>;
export async function readAnalysisPackage(
  directory: string,
): Promise<AnalysisPackageV1 | AnalysisPackageV2>;
~~~

- [ ] Add failing tests for complete v2 round trip, every artifact hash mismatch, missing artifact, symlinked artifact, path escape, secret-like nested metadata, recording permissions, and v1 package reading.
- [ ] Add an offline-build test that replaces global `fetch` with a throwing stub and succeeds from a recorded v2 package.
- [ ] Run `node --import tsx --test tests/analysis-package.test.ts tests/recording.test.ts tests/pipeline.test.ts`; expect failures.
- [ ] Implement safe relative-path resolution, regular-file checks, strict schemas, SHA-256 verification, recursive sanitization, and atomic package publication.
- [ ] Refactor analyze orchestration to run OCR/full Vision, select at most eight regional calls, execute at most four eligible completions, and write canonical source RGBA plus all masks/assets needed by build.
- [ ] Keep analysis v1 replay through the compatibility adapter. Never silently upgrade or mutate an old analysis directory.
- [ ] Extend durations and request counters without storing credentials, signed URLs, base64 images, or opaque provider tokens.
- [ ] Run focused tests, `npm run lint:types`, and `npm run build`; expect all to pass.
- [ ] Commit with `git add src/analysis src/pipeline.ts src/recording.ts tests/analysis-package.test.ts tests/recording.test.ts tests/pipeline.test.ts && git commit -m "feat: record self-contained semantic analysis packages"`.

---

### Task 10: Integrate atomic semantic candidates into the fidelity builder

**Files:**
- Modify: `src/fidelity/build.ts`
- Create: `tests/semantic-build.test.ts`
- Modify: `tests/fidelity-build.test.ts`
- Modify: `src/image/recompose.ts`
- Modify: `tests/recompose.test.ts`
- Modify: `src/contracts.ts`

**Interfaces:**

~~~ts
export type SemanticBuildInput = {
  source: SourceCanvas;
  ocr: OcrResult;
  graph: SceneGraph;
  plan: SemanticLayerPlan;
  completions: Map<string, CompletedCandidate>;
  workDir: string;
};
export type SemanticBuildResult = {
  manifest: SlideManifestV2;
  background: Buffer;
  acceptedAssets: BuiltAsset[];
  decisions: CandidateDecision[];
  recomposition: RecompositionResult;
};
export async function buildSemanticLayers(
  input: SemanticBuildInput,
): Promise<SemanticBuildResult>;
~~~

- [ ] Add failing end-to-end builder fixtures containing independent foreground objects, a compound object, a text backing, a rejected backing, accepted completion, rejected completion, and a z-order cycle.
- [ ] Assert that only accepted candidates enter the combined removal mask, each rejected candidate remains pixel-identical in the background, carries-text order is backing then text, and generated assets retain provenance/review flags.
- [ ] Add whole-page recomposition tests using all accepted layers in graph order, including overlapping alpha edges and ignored editable-text masks.
- [ ] Run `node --import tsx --test tests/semantic-build.test.ts tests/fidelity-build.test.ts tests/recompose.test.ts`; expect integration failures.
- [ ] Implement candidate-specific handlers over one transaction-like decision record. Stage masks/assets per candidate, validate locally, and merge into the committed removal union only after acceptance.
- [ ] Repair one final background from the committed union; validate bytes outside that union are unchanged. Recompose all layers and reject the affected candidate set if the page-level error gate fails.
- [ ] Emit manifest v2 elements with graph relationships and deterministic zIndex values. Continue routing v1 replay through the old builder until its tests prove compatibility.
- [ ] Run focused tests, all source tests, and `npm run lint:types`; expect all to pass.
- [ ] Commit with `git add src/fidelity/build.ts src/image/recompose.ts src/contracts.ts tests/semantic-build.test.ts tests/fidelity-build.test.ts tests/recompose.test.ts && git commit -m "feat: build atomic semantic fidelity layers"`.

---

### Task 11: Export arbitrary aspect ratios and generate QA previews

**Files:**
- Create: `src/export/layout.ts`
- Create: `src/qa/previews.ts`
- Create: `tests/export-layout.test.ts`
- Create: `tests/qa-previews.test.ts`
- Modify: `src/export/pptx.ts`
- Modify: `tests/pptx.test.ts`

**Interfaces:**

~~~ts
export type SlideLayout = { widthInches: number; heightInches: number };
export function layoutForCanvas(canvas: CanvasSize): SlideLayout;
export function positionForBBox(
  bbox: BBox,
  canvas: CanvasSize,
  layout: SlideLayout,
): { x: number; y: number; w: number; h: number };
export type QaPreviewRecord = {
  kind: "recomposition" | "layer-review" | "exploded";
  path: string;
  sha256: string;
};
export async function writeQaPreviews(input: {
  canvas: SourceCanvas;
  background: Buffer;
  assets: BuiltAsset[];
  manifest: SlideManifestV2;
  outDir: string;
}): Promise<QaPreviewRecord[]>;
~~~

- [ ] Add failing table tests for 16:9, 4:3, portrait, square, and 56:1 canvases. Assert long side 13.333 inches unless that makes the short side below 1 inch, then short side is exactly 1 inch and both sides remain within 1–56 inches.
- [ ] Add PPTX XML tests proving a custom layout is used, every image/text box shares one transform, all coordinates fit the page, and v1 1280×720 export remains visually equivalent.
- [ ] Add preview tests for `recomposition-preview.png`, checkerboard `layer-review.png`, and offset `exploded-preview.png`, including generated-region highlighting and deterministic output hashes.
- [ ] Run `node --import tsx --test tests/export-layout.test.ts tests/qa-previews.test.ts tests/pptx.test.ts`; expect hardcoded-wide-layout failures.
- [ ] Implement the layout formula and pass canvas/layout into every coordinate and font conversion. Define a PptxGenJS custom layout instead of `LAYOUT_WIDE`.
- [ ] Generate contact-sheet cells with stable labels from node IDs/roles, not semantic labels; add a visible generated-region review marker only in QA previews, never in the exported asset.
- [ ] Add the preview paths and hashes to run ledger outputs.
- [ ] Run focused tests, `npm run lint:types`, and `npm run build`; expect all to pass.
- [ ] Commit with `git add src/export src/qa tests/export-layout.test.ts tests/qa-previews.test.ts tests/pptx.test.ts && git commit -m "feat: export arbitrary layouts with qa previews"`.

---

### Task 12: Complete CLI, documentation, plugin, and compatibility wiring

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`
- Modify: `README.md`
- Modify: `skills/image-to-editable-pptx/SKILL.md`
- Modify: `.codex-plugin/plugin.json`
- Modify: `tests/plugin-package.test.ts`
- Modify: `package.json`

**Interfaces:**

~~~text
image-to-editable-pptx analyze <image> --out <dir>
  [--max-region-analysis <0..8>]
  [--max-occlusion-completions <0..4>]

image-to-editable-pptx build <image> --analysis <dir> --out <dir>
image-to-editable-pptx run <image> --out <dir>
  [--max-region-analysis <0..8>]
  [--max-occlusion-completions <0..4>]
~~~

- [ ] Add failing CLI tests for defaults, both zero-disable forms, range errors, non-integers, flags rejected on offline build, JPEG help text, and no unlimited value.
- [ ] Add package tests that assert the installed skill documents PNG/JPEG limits, network-stage boundaries, generated-layer review, output files, and the same CLI flags as the executable.
- [ ] Run `node --import tsx --test tests/cli.test.ts tests/plugin-package.test.ts`; expect documentation/CLI mismatches.
- [ ] Wire CLI options to config and pipeline limits. Keep API keys environment-only and never accept secrets as command-line flags.
- [ ] Update README and skill instructions with the generic behavior, safe fallbacks, manifest v2, QA review flow, and offline build promise. State plainly that text backings remain PNG assets rather than native PowerPoint shapes.
- [ ] Keep the existing package/plugin version during implementation; version selection is deferred until the complete source and compiled suites pass in Task 13.
- [ ] Run focused tests, `npm run lint:types`, and `npm run build`; expect all to pass.
- [ ] Commit with `git add src/cli.ts tests/cli.test.ts README.md skills/image-to-editable-pptx/SKILL.md .codex-plugin/plugin.json tests/plugin-package.test.ts package.json package-lock.json && git commit -m "docs: expose generic semantic layering workflow"`.

---

### Task 13: Run cross-cutting regression, security, and real-fixture acceptance

**Files:**
- Create: `tests/fixtures/semantic/`
- Create: `tests/generic-regression.test.ts`
- Modify: `tests/publication.test.ts`
- Modify: `tests/package-scripts.test.ts`
- Modify: `docs/superpowers/specs/2026-08-29-general-semantic-layering-design.md` only if implementation reveals a confirmed design correction

- [ ] Add bounded synthetic/redistributable fixtures for 16:9 PNG, 4:3 JPEG, portrait, square, ultrawide, text backings, connected composition, occlusion, and a must-fallback negative case. Store generation code or provenance beside fixtures.
- [ ] Add a generic source scan across `src/` that rejects page/object-specific branch tokens and rejects hardcoded 1280×720 math outside the v1 compatibility adapter/tests.
- [ ] Re-run atomic-publication tests with failures injected after analysis, after one accepted layer, during preview generation, and during PPTX write. Assert prior successful output is untouched and failed staging is retained according to the existing contract.
- [ ] Add redaction tests with secrets nested in regional/completion metadata and verify all generated JSON files have mode 0600.
- [ ] Run the complete source suite: `npm test`. Fix every reproducible failure at its owning layer and rerun until clean.
- [ ] Run `npm run lint:types && npm run build && npm run test:compiled`. Inspect test totals and require zero failures in both source and compiled suites.
- [ ] After both suites are green, choose the next local semver, apply the same value to package/plugin metadata and lockfile with `npm install --package-lock-only`, then rerun plugin-package, type, source, build, and compiled tests. This prepares but does not publish a release.
- [ ] Run `npm pack --dry-run`; inspect the file list for missing runtime files, accidental fixtures/secrets, absolute paths, or build artifacts that should not ship.
- [ ] Commit with `git add src tests docs package.json package-lock.json README.md skills .codex-plugin && git commit -m "test: verify generic semantic layering end to end"`.

---

### Task 14: Perform live provider and WPS acceptance without publishing

**Files:**
- Create: `docs/acceptance/2026-08-29-semantic-layering.md`
- Create under ignored output directory: live analysis/build artifacts for the approved slide and at least four additional format/aspect fixtures
- Modify: no release/tag/GitHub state in this task

- [x] Confirm the working tree contains no credentials and that Alibaba credentials are supplied only through the existing environment/config mechanism. Do not echo the key or signed URLs.
- [x] Run live `analyze` and offline `build` separately on the approved slide. Record request counts and prove build succeeds with network disabled.
- [x] Run the same pipeline on at least one JPEG, one non-16:9 image, one text-backing page, and one expected-fallback page.
- [x] Inspect each rendered PPTX beside the source, `recomposition-preview.png`, `layer-review.png`, and `exploded-preview.png`. Record accepted/rejected layers and every `reviewRequired` completion.
- [x] For the approved slide, verify generically that the eye/radar pair can become separate movable layers when the graph and masks support it, the wrench is independently movable when safely extracted, the shield/text backing is movable beneath editable text, and unsafe cases remain in the background. Do not add exceptions if any candidate fails. (User-approved fidelity-first boundary: text takes priority; the shield backing stays in background via the generic guard, no exceptions added.)
- [ ] In WPS, move one foreground object, move one text-backing asset, edit its associated text, undo all changes, explicitly choose save or discard, close, reopen, and verify the document state. Record the exact observed outcome.
- [x] Re-run `npm test && npm run lint:types && npm run build && npm run test:compiled` after any acceptance fix. Repeat live inspection only for affected paths until no worthwhile defect remains.
- [x] Write the acceptance report with commands, non-secret artifact paths, test totals, visual findings, WPS edit/undo/reopen result, known safe fallbacks, and whether the implementation meets each of the ten completion criteria in the spec.
- [x] Commit the report with `git add docs/acceptance/2026-08-29-semantic-layering.md && git commit -m "docs: record semantic layering acceptance"`.
- [x] Stop with a clean local branch and report the commit range. Do not push, tag, publish npm, update marketplace state, or overwrite installed plugin caches without explicit release authorization.
