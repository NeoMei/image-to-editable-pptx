# Image PPT Enhanced Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the source deck's slide 7 full-page bitmap into a PowerPoint slide with editable text, native panels/bars, movable icon images, and a clean inpainted background using only Alibaba Cloud APIs plus lightweight CPU code.

**Architecture:** A provider layer calls Qwen OCR, Qwen Vision, and Wanx image editing; a deterministic planner merges their responses into a versioned slide manifest; image utilities create masks and movable assets; a PptxGenJS exporter rebuilds the slide. Provider responses are recordable fixtures so all parsing, planning, image processing, and export tests run without network access.

**Tech Stack:** Node.js 22.6+, TypeScript, Node test runner with native test globs, OpenAI-compatible HTTP, native `fetch`, Zod, Sharp, PptxGenJS.

## Global Constraints

- Use Alibaba Cloud China-region APIs only.
- Do not deploy or execute local AI models and do not require a GPU.
- Require only `DASHSCOPE_API_KEY` and `DASHSCOPE_WORKSPACE_ID` for the first runnable prototype.
- Never persist API credentials or Authorization headers in fixtures, logs, or generated manifests.
- Keep the page coordinate system at 1280×720 pixels until export.
- Treat Qwen OCR as authoritative for text content and text coordinates.
- Rebuild high-confidence rectangles and bars as native PowerPoint shapes; preserve uncertain objects as bitmap crops.
- Stop the run if a clean background cannot be produced; never export a slide with duplicate source text hidden under editable text.
- The first acceptance target is source slide 7 only.

---

## File Map

- `package.json`: scripts and runtime dependencies.
- `tsconfig.json`: strict TypeScript settings.
- `.gitignore`: credentials, generated outputs, network recordings, and temporary assets.
- `src/contracts.ts`: all versioned manifest and provider schemas.
- `src/config.ts`: validated environment and model configuration.
- `src/providers/qwen-ocr.ts`: DashScope-native OCR request and response normalization.
- `src/providers/qwen-vision.ts`: OpenAI-compatible visual element analysis.
- `src/providers/wanx-edit.ts`: asynchronous Wanx masked inpainting.
- `src/recording.ts`: sanitized provider response recording and replay.
- `src/planner.ts`: deterministic merge of OCR and visual elements.
- `src/image/mask.ts`: merged text/object removal mask generation.
- `src/image/extract.ts`: crop and border-connected background removal.
- `src/export/pptx.ts`: editable PPTX generation.
- `src/pipeline.ts`: end-to-end orchestration and artifact ledger.
- `src/cli.ts`: `analyze`, `build`, and `run` commands.
- `tests/*.test.ts`: unit and integration tests.
- `tests/fixtures/*.json`: sanitized representative provider responses.
- `scripts/accept-slide-07.sh`: exact real-API acceptance command.

---

### Task 1: Repository Scaffold and Versioned Contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/contracts.ts`
- Test: `tests/contracts.test.ts`

**Interfaces:**
- Produces: `SlideManifestSchema`, `OcrResultSchema`, `VisionResultSchema`, `BBoxSchema`, and their inferred TypeScript types.
- Consumes: none.

- [ ] **Step 1: Initialize Git and write the failing schema test**

Run:

```bash
git init
mkdir -p src/providers src/image src/export tests/fixtures scripts output
```

Create `tests/contracts.test.ts` with a valid `manifestVersion: 1` sample and an invalid out-of-bounds bbox sample. Assert the valid sample parses and the invalid sample throws.

- [ ] **Step 2: Run the schema test and verify failure**

Run:

```bash
npm test -- tests/contracts.test.ts
```

Expected: failure because `src/contracts.ts` does not exist.

- [ ] **Step 3: Add package configuration and strict contracts**

Create `package.json` with:

```json
{
  "name": "image-ppt-layers",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.6" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "node --import tsx --test \"tests/*.test.ts\"",
    "test:compiled": "node --test \"dist/tests/*.test.js\"",
    "lint:types": "tsc -p tsconfig.json --noEmit",
    "cli": "tsx src/cli.ts"
  },
  "dependencies": {
    "openai": "^5.0.0",
    "pptxgenjs": "^4.0.1",
    "sharp": "^0.34.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.0"
  }
}
```

Define contracts with these exact discriminators:

```ts
export const BBoxSchema = z.object({
  x: z.number().min(0).max(1280),
  y: z.number().min(0).max(720),
  width: z.number().positive().max(1280),
  height: z.number().positive().max(720),
});

export const SlideElementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), id: z.string(), text: z.string(), bbox: BBoxSchema,
    rotation: z.number(), color: z.string(), fontSizePx: z.number().positive(), align: z.enum(["left", "center", "right"]), zIndex: z.number().int() }),
  z.object({ kind: z.literal("shape"), id: z.string(), label: z.string(), shape: z.enum(["rect", "roundRect", "ellipse", "line"]), bbox: BBoxSchema,
    fillColor: z.string(), strokeColor: z.string(), strokeWidthPx: z.number().nonnegative(), cornerRadiusPx: z.number().nonnegative(), zIndex: z.number().int() }),
  z.object({ kind: z.literal("asset"), id: z.string(), label: z.string(), bbox: BBoxSchema,
    extraction: z.enum(["transparent", "rectangular"]), assetPath: z.string(), zIndex: z.number().int(), fallbackReason: z.string().optional() }),
]);
```

Add a `superRefine` check that rejects `x + width > 1280` or `y + height > 720`.

- [ ] **Step 4: Install dependencies and run tests**

Run:

```bash
npm install
npm test -- tests/contracts.test.ts
npm run lint:types
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/contracts.ts tests/contracts.test.ts
git commit -m "feat: define image-to-ppt manifest contracts"
```

---

### Task 2: Configuration and Sanitized Provider Recording

**Files:**
- Create: `src/config.ts`
- Create: `src/recording.ts`
- Test: `tests/config.test.ts`
- Test: `tests/recording.test.ts`

**Interfaces:**
- Produces: `loadConfig(env): AppConfig`, `writeRecording(path, payload): Promise<void>`, `readRecording<T>(path, schema): Promise<T>`.
- Consumes: Zod schemas from `src/contracts.ts`.

- [ ] **Step 1: Write failing tests**

Test these cases exactly:

- missing `DASHSCOPE_API_KEY` reports that variable name;
- missing `DASHSCOPE_WORKSPACE_ID` reports that variable name;
- Beijing URLs are derived from the workspace ID;
- nested `authorization`, `apiKey`, `access_token`, and headers matching `/^x-dashscope-/i` are removed before recording;
- a sanitized fixture round-trips through a supplied Zod schema.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- tests/config.test.ts tests/recording.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 3: Implement configuration and recording**

`loadConfig` must return:

```ts
export type AppConfig = {
  apiKey: string;
  workspaceId: string;
  dashscopeApiBase: string;
  dashscopeCompatibleBase: string;
  ocrModel: "qwen3.5-ocr";
  visionModel: string;
  editModel: "wanx2.1-imageedit";
  requestTimeoutMs: number;
  pollIntervalMs: number;
};
```

Use these URL templates:

```ts
const host = `https://${workspaceId}.cn-beijing.maas.aliyuncs.com`;
dashscopeApiBase = `${host}/api/v1`;
dashscopeCompatibleBase = `${host}/compatible-mode/v1`;
```

Sanitize recursively before writing pretty JSON with a trailing newline.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/config.test.ts tests/recording.test.ts
npm run lint:types
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/recording.ts tests/config.test.ts tests/recording.test.ts
git commit -m "feat: add safe Alibaba API configuration"
```

---

### Task 3: Qwen OCR and Vision Providers

**Files:**
- Create: `src/providers/qwen-ocr.ts`
- Create: `src/providers/qwen-vision.ts`
- Create: `tests/fixtures/qwen-ocr-slide-07.json`
- Create: `tests/fixtures/qwen-vision-slide-07.json`
- Test: `tests/qwen-ocr.test.ts`
- Test: `tests/qwen-vision.test.ts`

**Interfaces:**
- Produces: `recognizeText(image: Buffer, config: AppConfig): Promise<OcrResult>`.
- Produces: `analyzeElements(image: Buffer, config: AppConfig): Promise<VisionResult>`.
- Consumes: `AppConfig`, `OcrResultSchema`, and `VisionResultSchema`.

- [ ] **Step 1: Write failing fixture parser tests**

The OCR test must cover four-point locations and normalize them to `{x,y,width,height}`. The vision test must reject Markdown fences around JSON only after stripping a single outer fence, then validate element types and bbox values.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- tests/qwen-ocr.test.ts tests/qwen-vision.test.ts
```

Expected: provider modules are missing.

- [ ] **Step 3: Implement OCR request**

POST to:

```text
{dashscopeApiBase}/services/aigc/multimodal-generation/generation
```

Use headers `Authorization: Bearer ...` and `Content-Type: application/json`. Send:

```json
{
  "model": "qwen3.5-ocr",
  "input": { "messages": [{ "role": "user", "content": [{ "image": "data:image/png;base64,...", "enable_rotate": false }] }] },
  "parameters": { "ocr_options": { "task": "advanced_recognition" } }
}
```

Normalize each `ocr_result.words_info[]` line's four-point `location` to an axis-aligned bbox, retaining the original quad and text. Reject the coordinate-free plain-text envelope produced by `text_recognition`.

- [ ] **Step 4: Implement vision request**

Use the OpenAI client with `baseURL: config.dashscopeCompatibleBase` and `model: config.visionModel`. The prompt must demand JSON only and use the exact element enum from the design. Include the canvas size and instruct the model not to duplicate OCR text as graphical assets.

- [ ] **Step 5: Run provider tests and typecheck**

Run:

```bash
npm test -- tests/qwen-ocr.test.ts tests/qwen-vision.test.ts
npm run lint:types
```

Expected: exit 0 with no network calls.

- [ ] **Step 6: Commit**

```bash
git add src/providers tests/fixtures/qwen-ocr-slide-07.json tests/fixtures/qwen-vision-slide-07.json tests/qwen-ocr.test.ts tests/qwen-vision.test.ts
git commit -m "feat: add Qwen OCR and layout providers"
```

---

### Task 4: Deterministic Slide Planner

**Files:**
- Create: `src/planner.ts`
- Test: `tests/planner.test.ts`

**Interfaces:**
- Produces: `planSlide(ocr: OcrResult, vision: VisionResult): SlideManifest`.
- Consumes: normalized OCR and vision results.

- [ ] **Step 1: Write failing planner tests**

Cover these exact behaviors:

- OCR text wins over overlapping visual `text` candidates;
- visual rectangles with confidence at least `0.85` become native shapes;
- uncertain rectangles become bitmap assets;
- candidates with `type: background` or `editableAs: background` never become foreground assets or removal-mask targets;
- adjacent aligned OCR body lines with similar estimated font sizes merge, while distant, shifted, or differently sized lines remain separate;
- bbox values are clipped and an `out_of_bounds_clipped` warning is emitted;
- elements are sorted by `zIndex`, then stable input order;
- the slide 7 fixture produces at least one title text, eight semantically named native shapes (top label, subtitle bar, three main panels, two separated right-side panels, bottom bar), and six movable asset candidates.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- tests/planner.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement minimal deterministic merge**

Use intersection-over-union greater than `0.5` to suppress duplicate text candidates. Estimate text color from the vision hint when present and default to `23394D`. Estimate each source line's `fontSizePx` as `bbox.height * 0.72`, clamped to `[14, 88]`. Merge only consecutive OCR lines whose non-negative vertical gap is at most 75% of the smaller line height (minimum tolerance 4 px), whose left edges differ by at most 50% of the smaller estimated font size (minimum tolerance 4 px), and whose estimated font-size ratio is at most `1.2`; join their exact text with a newline, use the coordinate union, and retain the median per-line estimate as the merged font size.

- [ ] **Step 4: Run planner tests and all offline tests**

Run:

```bash
npm test -- tests/planner.test.ts
npm test
npm run lint:types
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/planner.ts tests/planner.test.ts
git commit -m "feat: merge OCR and visual elements"
```

---

### Task 5: Asset Extraction and Removal Mask

**Files:**
- Create: `src/image/extract.ts`
- Create: `src/image/mask.ts`
- Test: `tests/extract.test.ts`
- Test: `tests/mask.test.ts`

**Interfaces:**
- Produces: `extractAsset(source, bbox, options): Promise<ExtractedAsset>`.
- Produces: `buildRemovalMask(width, height, elements, paddingPx): Promise<Buffer>`.
- Consumes: planned shape, text, and asset elements.

- [ ] **Step 1: Write failing synthetic-image tests**

Generate test images in memory with Sharp. Assert that:

- a navy square on a cream border becomes transparent around the border;
- a crop touching multiple non-cream edge colors falls back to `rectangular`;
- the mask is exactly 1280×720, black outside targets, white inside padded text and asset bounds;
- mask padding is clipped at canvas edges.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- tests/extract.test.ts tests/mask.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 3: Implement border-connected background removal**

Decode the crop to RGBA. Sample edge pixels, compute the median edge color, flood-fill edge-connected pixels whose maximum RGB channel distance is at most `24`, and set their alpha to zero. If fewer than 5% or more than 92% of pixels become transparent, return the original rectangular crop with a specific `fallbackReason`.

- [ ] **Step 4: Implement merged mask generation**

Render an SVG mask with a black background and white polygons/rounded rectangles. Expand text by 4 pixels, assets by 6 pixels, and native shapes by 2 pixels. Return PNG from Sharp.

- [ ] **Step 5: Run image tests and all offline tests**

Run:

```bash
npm test -- tests/extract.test.ts tests/mask.test.ts
npm test
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/image tests/extract.test.ts tests/mask.test.ts
git commit -m "feat: extract movable assets and removal masks"
```

---

### Task 6: Wanx Background Inpainting

**Files:**
- Create: `src/providers/wanx-edit.ts`
- Test: `tests/wanx-edit.test.ts`

**Interfaces:**
- Produces: `inpaintBackground(source: Buffer, mask: Buffer, config: AppConfig): Promise<{image: Buffer; taskId: string}>`.
- Consumes: `AppConfig` and PNG buffers.

- [ ] **Step 1: Write failing mocked-fetch tests**

Cover submission, `PENDING` polling, `RUNNING` polling, `SUCCEEDED` download, terminal failure, timeout, and preservation of `task_id` in thrown errors.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npm test -- tests/wanx-edit.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement asynchronous Wanx calls**

Submit to:

```text
{dashscopeApiBase}/services/aigc/image2image/image-synthesis
```

with `X-DashScope-Async: enable`, `model: wanx2.1-imageedit`, `function: description_edit_with_mask`, Base64 source and mask, and this prompt:

```text
移除白色遮罩区域中的文字、图标、线条和面板边框，延续周围米白色纸张纹理与自然阴影，不添加任何新文字、符号、物体或装饰。
```

Poll `{dashscopeApiBase}/tasks/{taskId}` until success or the configured timeout. Download the temporary result only when it is HTTPS, has no userinfo, non-default port, or fragment, and its hostname matches the documented `dashscope-result-*.oss-cn-*.aliyuncs.com` OSS family. Disable redirects and reject every other URL before download.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test -- tests/wanx-edit.test.ts
npm run lint:types
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/providers/wanx-edit.ts tests/wanx-edit.test.ts
git commit -m "feat: add Wanx masked background cleanup"
```

---

### Task 7: Editable PPTX Exporter

**Files:**
- Create: `src/export/pptx.ts`
- Test: `tests/pptx.test.ts`

**Interfaces:**
- Produces: `exportPptx(manifest, backgroundPath, outputPath): Promise<void>`.
- Consumes: finalized `SlideManifest` and extracted asset paths.

- [ ] **Step 1: Write failing export test**

Export a synthetic manifest, unzip the result in the test, and assert:

- one slide exists;
- slide size is 13.333×7.5 inches;
- editable text exists in slide XML;
- native rectangle shapes exist;
- each asset has a distinct relationship;
- the full-slide background is behind all other elements;
- generated element names begin with `text-`, `shape-`, or `asset-`, and native shape names retain their semantic label.

- [ ] **Step 2: Verify test fails**

Run:

```bash
npm test -- tests/pptx.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement coordinate mapping and export**

Use:

```ts
const pxToX = (px: number) => px * 13.333 / 1280;
const pxToY = (px: number) => px * 7.5 / 720;
const pxToPt = (px: number) => px * 72 / 96;
```

Set `pptx.layout = "LAYOUT_WIDE"`, use `Microsoft YaHei` as the first prototype font, preserve z-order by insertion order, and disable text auto-fit that changes box geometry.

- [ ] **Step 4: Run exporter and full offline suite**

Run:

```bash
npm test -- tests/pptx.test.ts
npm test
npm run build
```

Expected: exit 0 and a readable synthetic PPTX in the test temporary directory.

- [ ] **Step 5: Commit**

```bash
git add src/export/pptx.ts tests/pptx.test.ts
git commit -m "feat: export editable PowerPoint layers"
```

---

### Task 8: Pipeline, CLI, and Slide 7 Acceptance

**Files:**
- Create: `src/pipeline.ts`
- Create: `src/cli.ts`
- Create: `scripts/accept-slide-07.sh`
- Test: `tests/pipeline.test.ts`
- Create: `README.md`

**Interfaces:**
- Produces: CLI commands `analyze`, `build`, and `run`.
- Consumes: all provider, planner, image, and exporter interfaces.

- [ ] **Step 1: Write failing replay-mode pipeline test**

Run the pipeline with recorded OCR/Vision fixtures and a mocked Wanx result. Assert the artifact directory contains `ocr.json`, `vision.json`, `manifest.json`, `removal-mask.png`, `clean-background.png`, an `assets/` directory, `run-ledger.json`, and the final PPTX.

- [ ] **Step 2: Verify test fails**

Run:

```bash
npm test -- tests/pipeline.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the orchestrator and CLI**

Command contracts:

```text
npm run cli -- analyze --image <png> --out <dir> [--record]
npm run cli -- build --image <png> --analysis <dir> --out <dir>
npm run cli -- run --image <png> --out <dir> [--record]
```

The ledger must contain model IDs, durations, task IDs, warnings, fallbacks, SHA-256 hashes, and output paths, but no secrets or Authorization headers.

Both `run` and standalone `build` use a sibling staging directory, atomic promotion, owned-target backup validation, and failed-run retention. Standalone `analyze` requires a new or empty output directory. Live OCR/Vision envelopes are recorded through a provider-boundary observer before normalization; successful temporary raw envelopes are removed, while malformed sanitized envelopes and parse errors remain in the failed-run directory.

- [ ] **Step 4: Add exact slide 7 acceptance script**

`scripts/accept-slide-07.sh` must resolve the inspected PNG at:

```text
/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png
```

and run:

```bash
npm run cli -- run --image "$SLIDE_IMAGE" --out output/slide-07 --record
```

It must fail before network access if either required environment variable is absent.

- [ ] **Step 5: Document setup and run offline verification**

README must document Alibaba Model Studio API key and workspace ID setup, the three CLI modes, output files, data sent to Alibaba Cloud, expected API cost, and known limitations.

Run:

```bash
npm test
npm run build
npm run test:compiled
```

Expected: exit 0. `npm test` runs source tests only; `npm run test:compiled` separately validates the freshly built JavaScript tests.

- [ ] **Step 6: Execute the real API run**

Run:

```bash
DASHSCOPE_API_KEY="$DASHSCOPE_API_KEY" \
DASHSCOPE_WORKSPACE_ID="$DASHSCOPE_WORKSPACE_ID" \
bash scripts/accept-slide-07.sh
```

Expected: `output/slide-07/slide-07-editable.pptx` plus the complete ledger and intermediate assets.

- [ ] **Step 7: Verify the delivered presentation**

Render the final PPTX, inspect the full slide, compare text and object positions against the source, run an XML check for editable text and distinct images, and open it in WPS or PowerPoint. Record each acceptance criterion as pass/fail in `output/slide-07/acceptance.txt`.

- [ ] **Step 8: Commit**

```bash
git add src/pipeline.ts src/cli.ts scripts/accept-slide-07.sh tests/pipeline.test.ts README.md
git commit -m "feat: run enhanced image-to-ppt prototype"
```

---

## Self-Review Results

- Spec coverage: all approved requirements map to Tasks 3–8; optional Alibaba VIAPI segmentation is intentionally excluded from the first runnable dependency set and remains documented in the design.
- Placeholder scan: the plan contains no deferred implementation markers; every task names files, interfaces, tests, commands, and expected outcomes.
- Type consistency: provider outputs flow through `OcrResult`/`VisionResult`, planner output is `SlideManifest`, image steps consume manifest elements, and exporter consumes the finalized manifest and asset paths.
