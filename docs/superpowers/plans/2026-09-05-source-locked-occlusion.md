# Source-Locked Occlusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept trustworthy hidden-region reconstruction while preserving every original visible RGBA byte and retaining uncertain objects in the background.

**Architecture:** Separate request construction, source-local appearance validation, and deterministic final composition. Model output supplies candidate pixels only; graph geometry and local code own edit authority. Preserve current provider routing and v2 package contracts, adding an independent diagnostic sidecar.

**Tech Stack:** TypeScript ESM, Node.js 22.6+, sharp, Zod, node:test, existing provider adapters and PPTX exporter; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-source-locked-occlusion-design.md` — read completely before execution.

## Global Constraints

- Final visible RGBA must equal the original source byte-for-byte.
- Generated support must be disjoint from visible support and contained in the proven hidden mask.
- Everything outside their union is transparent in the asset.
- Every generated layer remains `reviewRequired: true`.
- Never enlarge the hidden region to make a failed sample pass.
- Quality rejection does not advance providers.
- Preserve unavailable/auth/retryable-only routing advancement, terminal refusal and malformed-output behavior, request budgets, timeout ownership, and the offline `build` boundary.
- No automatic release, installation update, new credentials, or added vision-verifier calls.
- Do not tune thresholds against a rejected live response.

## Execution context and change ownership

Work only in `/Users/neomei/项目/codexprojects/image-to-editable-pptx/.worktrees/model-fallback`, branch `codex/model-fallback`. Main checkout and other worktrees are out of scope. The existing linked worktree has no `.codegraph/`; do not use or synchronize the parent checkout's index against it.

The design was committed at `ad99140`. The working tree already includes reviewed but uncommitted routing, alpha-mask, text-backing, typography, packaging, and regression changes. They are part of the effective baseline, not new work from this plan. Before execution, record `git status --short`, `git diff --stat`, and `git diff --cached --name-only`; preserve all changes. Run `npm run verify` against that baseline before new code. Last historical result was 493 source and 493 compiled tests; it is not fresh evidence.

Use exact-path commits only after checking the staged diff. When a task modifies an already dirty file, distinguish baseline and new hunks in review; do not accidentally claim ownership of or discard baseline changes. No `git add .`, resets, branch switching, pushes, or package publication. Coordinate implementation and independent reviews in this Codex task; no new user-visible tasks. Task dependencies are sequential; reviewers may run alongside unrelated verification, never concurrent edits to shared files.

## File map

| File | Responsibility |
| --- | --- |
| `src/occlusion/request.ts` (new) | Cleared model crop and bounded, quoted scene context |
| `src/occlusion/quality.ts` (new) | Source appearance qualification, hidden support, seam/residual metrics |
| `src/occlusion/diagnostics.ts` (new) | Strict bounded outcome/sidecar schema, no raw provider strings |
| `src/occlusion/contracts.ts` | Shared internal result and metric types; keep artifact fields |
| `src/occlusion/complete.ts` | Evidence, budget, provider, validation, source-locked composition |
| `src/pipeline.ts` | Scene context and private sidecar publication in existing staging |
| `src/providers/provider-routing.ts` | Shared completion prompt; no routing-order changes |
| `src/providers/provider-adapters.ts`, `src/providers/opencodex-bridge.ts` | Transport-specific input/mask contracts only if tests expose a mismatch |
| `src/fidelity/build.ts`, `src/analysis/package.ts` | Existing validators remain authoritative; change only for demonstrated integration defects |
| `tests/fixtures/occlusion/source-locked.ts` (new) | Deterministic source, masks, valid and invalid returned crops |
| `tests/occlusion-request.test.ts`, `tests/occlusion-quality.test.ts` (new) | Request and quality unit/threshold regressions |
| `tests/occlusion-complete.test.ts`, `tests/semantic-build.test.ts` | Completion-to-real-layer behavior |
| `tests/routed-pipeline.test.ts`, `tests/provider-adapters.test.ts`, `tests/opencodex-bridge.test.ts`, `tests/wanx-edit.test.ts`, `tests/analysis-package.test.ts` | Transport, atomicity, compatibility integration |
| `docs/verification/2026-09-05-source-locked-occlusion.md` (new) | Frozen calibration and acceptance evidence |

### Task 1: Clear the editable input and identify the rear object

**Files:** Create `src/occlusion/request.ts`, `tests/occlusion-request.test.ts`, `tests/fixtures/occlusion/source-locked.ts`; modify `src/occlusion/complete.ts`, `src/pipeline.ts`, `src/providers/provider-routing.ts`; extend existing adapter/bridge/Wanx tests.

**Interfaces:**

```ts
export type CropRaster = { width: number; height: number; rgba: Buffer };
export function clearHiddenPixels(source: CropRaster, hidden: Uint8Array): Buffer;
export function completionContext(
  graph: SceneGraph, candidate: SemanticCandidate,
): string[];
```

`clearHiddenPixels` returns raw RGBA, never mutates input. `completionContext` uses `candidate.nodeIds` and `candidate.occlusion.occluderIds`; it does not alter either list or geometry. Imports come from `scene/contracts.ts` and `scene/plan.ts`.

- [ ] Write request tests before implementation, using this exact independent expected result:

```ts
test("clears only hidden RGBA without mutating source", () => {
  const rgba = Buffer.from([10,20,30,255, 230,90,20,255, 40,50,60,128]);
  const snapshot = Buffer.from(rgba);
  const actual = clearHiddenPixels({ width:3, height:1, rgba }, Uint8Array.of(0,255,0));
  assert.deepEqual(actual, Buffer.from([10,20,30,255, 0,0,0,0, 40,50,60,128]));
  assert.deepEqual(rgba, snapshot);
  assert.notEqual(actual, rgba);
});
```

Also reject wrong mask length, invalid dimensions, wrong RGBA length. Test hostile labels as quoted JSON data, not appended instructions. Limit descriptive context to 8 rear nodes and 8 front nodes, 200 Unicode code points per label and 128 per ID, 8 KiB total UTF-8; clip descriptions only, never required mask checks. Sort IDs for deterministic output. Missing accepted nodes must fail closed rather than invent labels.

- [ ] Run `node --import tsx --test tests/occlusion-request.test.ts`; observe the missing behavior before implementation.
- [ ] Implement the pure copy/clear operation:

```ts
const result = Buffer.from(source.rgba);
for (let i = 0; i < hidden.length; i += 1) {
  if (hidden[i]! >= 16) result.fill(0, i * 4, i * 4 + 4);
}
return result;
```

Validate lengths before this loop. Serialize clipped descriptors with `JSON.stringify` into a separately delimited scene-data block; fixed instructions say to continue the rear object, not recreate front objects/text or a collage. Preserve source `input.crop`; PNG-encode cleared raw bytes only for `provider.complete({crop: ...})` after existing hidden-evidence checks.

- [ ] Build the reusable fixture: 32×24 opaque cream `[247,243,233,255]`, rear blue `[40,100,160,255]` rectangle `x=4..27,y=4..19`, front orange `[230,90,20,255]` strip `x=14..17,y=2..21`. Paint front last. Explicit masks use these integer ranges. Valid returned crop restores blue only in rear/front intersection and cream in remaining hidden strip; bad returns retain front, shift rear by 4 pixels, use green, or introduce a one-pixel black seam. Return original/valid PNGs, raw rasters, masks and geometry; do not obtain expected data from production helpers.
- [ ] Capture real outgoing transport bodies in existing injected-fetch tests: OpenAI host JSON edits, OpenAI API multipart, Gemini host/API inline images, and Wanx submission must all receive the cleared crop. Verify alpha mask polarity and crop-padding reversal with fixed pixel coordinates, not source-string assertions. Do not change endpoints or capabilities based on assumptions.
- [ ] Run request, adapter, bridge, Wanx and completion tests plus `npm run lint:types`. Independent task review, then exact-path commit `fix: prepare explicit rear-object completion inputs`.

### Task 2: Qualify appearance and validate hidden content offline

**Files:** Create `src/occlusion/quality.ts`, `tests/occlusion-quality.test.ts`; extend fixture module; create calibration section of verification document.

**Interfaces:**

```ts
export type AppearanceInput = {
  source: CropRaster; visible: Uint8Array; hidden: Uint8Array;
  occluder: Uint8Array; contacts: readonly number[];
};
export type AppearanceProfile = {
  rear: readonly [number,number,number];
  front: readonly [number,number,number];
  background: readonly [number,number,number];
};
export type QualityReason = "insufficient_evidence" | "ambiguous_appearance"
  | "geometry" | "residual_occluder" | "seam_mismatch" | "contour_mismatch";
export type QualityMetrics = {
  rearSamples:number; frontSamples:number; backgroundSamples:number;
  generatedPixels:number; residualPixels:number; seamMaxDelta:number;
  returnedOutsideChangedPixels:number; returnedVisibleChangedPixels:number;
};
export function qualifyAppearance(input: AppearanceInput):
  {ok:true; profile:AppearanceProfile} | {ok:false; reason:QualityReason};
export function assessHiddenCandidate(input: AppearanceInput & {
  returned:CropRaster; profile:AppearanceProfile;
}): {ok:true; generated:Uint8Array; metrics:QualityMetrics}
  | {ok:false; reason:QualityReason; metrics:QualityMetrics};
```

Use `CropRaster` from Task 1. Contacts are the unique endpoint indices from existing evidence pairs. These helpers do not issue requests, fit synthetic shapes, composite pixels, or mutate input. Existing contact/contour gates remain in `complete.ts`.

- [ ] Add table-driven tests using Task 1's independent fixture. Assert actual generated mask counts and reasons, not only stub calls:

```ts
assert.equal(accepted.ok, true);
if (!accepted.ok) assert.fail(accepted.reason);
assert.equal(accepted.metrics.generatedPixels, 64); // 4 hidden columns × 16 rear rows
assert.equal(accepted.generated[3 * 32 + 15], 0); // identifiable background
assert.equal(accepted.generated[10 * 32 + 15], 255);
assert.equal(retainedFront.ok, false);
if (retainedFront.ok) assert.fail("occluder must not become rear content");
assert.equal(retainedFront.reason, "residual_occluder");
```

Initialize these results by `qualifyAppearance` and `assessHiddenCandidate` on original, valid and retained-front fixture rasters. Reject no samples, one-side samples, same-color front/rear, high-variation rear, gradients beyond scope, glowing edges, background-only, wrong-color, shifted and shaded-front returns. Missing geometric continuation is not repaired by appearance classification.

- [ ] Run `node --import tsx --test tests/occlusion-quality.test.ts` and observe failures. Do not call live providers during calibration.
- [ ] Implement source-local profiling: sample opaque visible interior within 3 pixels of contacts, original opaque front interior inside hidden support, and opaque source background outside visible/occluder support within 3 pixels of candidate support. Exclude alpha fringes and insufficient coverage of either contact side. Use per-channel medians and maximum channel distance. Require at least 8 samples per appearance class, source p95 deviation at most 6 levels, and pairwise palette separation at least 36 levels. These are initial offline calibration candidates, not measured product guarantees.
- [ ] Implement classification using candidate palette distance at most 12 levels; reject ties or ambiguous color rather than choosing nearest blindly. Transparent returned pixels do not form generated support. Background-classified pixels remain transparent in final asset. Require zero front-classified pixels and no unknown opaque pixels inside hidden support. For each visible/generated contact, require maximum channel delta at most 12 and opaque interior alpha at least 240; preserve the existing alpha-16 support threshold elsewhere. Test exact thresholds and one level beyond, varied scales/colors, diagonal antialiasing, one-pixel seams, and disconnected islands. Reject fringe situations not reliably classified; do not recolor candidate pixels or enlarge support.
- [ ] Document fixture labels and a calibration table, including which initial thresholds failed independently labeled examples and the final values selected. Freeze constants in code before Task 5. If good/bad offline samples cannot be separated conservatively, stop for design review; do not use the live orange-bar response to choose thresholds. Record that uniform-color fake geometry cannot be proven semantically correct by color checks alone; final contour, recomposition and human review remain required.
- [ ] Run quality tests, typecheck and independent task review; exact-path commit `feat: validate source-local hidden completion appearance`.

### Task 3: Compose a source-locked artifact and retain compatibility

**Files:** Modify `src/occlusion/complete.ts`, `src/occlusion/contracts.ts`, `tests/occlusion-complete.test.ts`, `tests/semantic-build.test.ts`; add private outcome schemas in `src/occlusion/diagnostics.ts`.

**Interfaces:**

```ts
export type CompletionReason = QualityReason | "disabled" | "provider_failure"
  | "invalid_metadata" | "invariant_failure";
export type CompletionOutcome =
  | {status:"accepted"; artifact:CompletedCandidate; metrics:QualityMetrics}
  | {status:"skipped" | "rejected"; reason:CompletionReason; metrics?:QualityMetrics};
export function evaluateOccludedCandidate(
  input:OcclusionCompletionInput, provider:OcclusionCompletionProvider,
): Promise<CompletionOutcome>;
```

Keep `completeOccludedCandidate(input,provider): Promise<CompletedCandidate | undefined>` as wrapper. `QualityReason`/metrics import from Task 2; existing artifact fields remain unchanged. Routing terminal errors still throw.

- [ ] Replace raw-return-equality rejection tests with source-locked-result tests: take valid hidden content, alter every returned outside-hidden pixel to magenta, then assert accepted final visible RGBA equals original and no magenta escapes. Use the new large fixture for appearance qualification rather than disabling quality checks for legacy tiny fixtures. Retain dedicated evidence-only cases for small geometry.
- [ ] Add explicit negative cases for bad hidden content, false metadata, timeout, budget 0/4, missing masks/relations, full-canvas crops and invalid contours. Assert no provider request occurs when appearance is unqualified. Hash original source and request independently; provenance must refer to original source even though provider received a cleared crop.
- [ ] Run focused tests and observe failing new result invariants before changing composition. Then call qualification before budget acquisition, call provider once within existing ownership, validate returned content and existing contact bridges/contour before composition.
- [ ] Implement final composition without restoring pixels into or mutating the provider-return buffer:

```ts
const composite = Buffer.alloc(original.rgba.length);
for (let i = 0; i < visible.length; i += 1) {
  const offset = i * 4;
  if (visible[i]! >= 16) original.rgba.copy(composite, offset, offset, offset + 4);
  else if (generated[i]! >= 16) returned.rgba.copy(composite, offset, offset, offset + 4);
}
```

Independently check lengths, every visible RGBA byte, visible/generated disjointness, generated containment in hidden evidence, and zero alpha elsewhere. Do not compare against cleared request bytes. Populate current mask/image hashes and `reviewRequired:true`. Outside-mask returned differences become numeric diagnostics only; bad hidden content remains rejection. Optional-result wrapper unwraps accepted outcome and returns undefined otherwise without swallowing terminal errors.
- [ ] Add a semantic-build integration using the actual completion function rather than a preassembled completion artifact; verify accepted asset, provenance and successful recomposition. Perturb one final visible byte and confirm offline build rejects it. Run `node --import tsx --test tests/occlusion-complete.test.ts tests/semantic-build.test.ts` plus typecheck. Independent review then exact-path commit `fix: lock visible source pixels during completion composition`.

### Task 4: Publish bounded diagnostics and exercise the full offline boundary

**Files:** Modify `src/occlusion/diagnostics.ts`, `src/pipeline.ts`, `tests/routed-pipeline.test.ts`, `tests/analysis-package.test.ts`; extend verification documentation and `docs/host-routing.md`.

**Interfaces:** Sidecar filename `completion-diagnostics.json`; strict schema:

```ts
type CompletionDiagnostics = {
  version:1;
  candidates:Array<{
    sequence:number;
    status:"accepted" | "skipped" | "rejected";
    reason?:CompletionReason;
    metrics?:QualityMetrics;
  }>;
};
```

Sequence is the deterministic canonical-plan candidate index; store no scene labels, IDs, arbitrary provider messages, filesystem paths or URLs. Only safe integers and finite bounded metric values; reject unknown keys, invalid enum values, accepted-with-reason, or skipped/rejected-without-reason. Version is literal 1. Existing v2 ledger fields and package hashes do not gain undeclared fields.

- [ ] Add a routed pipeline test where completion transport succeeds but quality rejects. Assert one request, no completion artifact, retained background, transport success retained in routing report, and sidecar reason. Assert next candidate does not switch providers due to this quality failure. Test terminal refusal still aborts the analysis and does not become a quality rejection.
- [ ] Add package tests: old v2 without sidecar loads; valid sidecar is not trusted for offline acceptance; corrupt optional sidecar cannot turn an invalid artifact valid; build makes zero network requests. End-to-end success must use an actual evaluated completion and survive package save/read/build.
- [ ] Run tests RED, then switch `completeEligibleCandidates` to the detailed outcome, preserving artifact/request counting. Validate/write the sidecar in the already owned analysis staging directory before atomic publication. Write with existing private recording helpers and refuse foreign/symlink targets; include sidecar in any exact ownership inventory. Do not overwrite earlier successful output on a write failure. Implement the same behavior for routed and legacy live analysis; offline builds do not create a new quality verdict.
- [ ] Exercise sidecar write failure, replacement/symlink race, rejection with no artifacts, and cleanup of owned staging without touching foreign files. Do not persist raw images by default. Keep diagnostic image capture in the explicit private acceptance harness, outside public package content, rather than adding a new CLI switch.
- [ ] Document the distinction between transport success, quality acceptance and final editor acceptance; document conservative appearance scope and no quality-driven fallback. Run `node --import tsx --test tests/routed-pipeline.test.ts tests/analysis-package.test.ts tests/cli.test.ts` and typecheck, then independent review and exact-path commit `feat: record bounded completion quality outcomes`.

### Task 5: Freeze offline gates, review the branch, then verify live artifacts

**Files:** Extend `docs/verification/2026-09-05-source-locked-occlusion.md`; use new ignored output directories beneath `.codex-tmp/release-v0.3.0/`. No production edits during live acceptance without returning to an offline failing test/review cycle.

**Interfaces:** Production CLI `run`, self-contained `build`, versioned sidecar from Task 4, existing routing/analysis/run ledgers and three QA previews.

- [ ] Run `npm run verify`, `npm pack --dry-run --json`, `git diff --check`; save exact counts/exit status. Retain the existing audit exception policy rather than downgrading dependencies. Independently review the whole effective branch, including relevant pre-plan dirty changes; close findings before live claims.
- [ ] In a private harness, replay the saved original/returned crop pair from `completion-diagnostic-5hospK` through the new gate without network. Confirm retained orange content is rejected with a precise quality reason. Do not normalize that saved bad return to make it accepted. Re-run all labeled good/bad calibration cases and record the fixed threshold revision.
- [ ] Run one fresh natural CLI case with the source fixture and no injected scene geometry:

```bash
node --import tsx src/cli.ts run .codex-tmp/release-v0.3.0/occlusion-source.png --out .codex-tmp/release-v0.3.0/source-locked-natural --max-region-analysis 2 --max-occlusion-completions 1
```

Refuse existing output paths; use a new explicit suffix if needed. If regional analysis fails, preserve the failure record. A supported `--max-region-analysis 0` isolation run may diagnose completion but must be reported separately, not represented as the default path passing. Do not repeatedly retry malformed output or adjust frozen thresholds to obtain a success.
- [ ] Inspect routing selection, actual request counts, sidecar quality decision and nonempty completion artifacts. Independently compare final visible RGBA to original, verify hidden containment and absence of the occluder, then run offline rebuild:

```bash
node --import tsx src/cli.ts build --analysis .codex-tmp/release-v0.3.0/source-locked-natural --out .codex-tmp/release-v0.3.0/source-locked-offline
```

Inspect recomposition, layer-review and exploded previews. A retained-background circle or unchanged orange bar is not success, regardless of transport status. Verify each available provider route separately before claiming its new input contract works; do not force genuine account failures or introduce credentials. Report unavailable/unproven API routes explicitly.
- [ ] If a generated asset is accepted, read the WPS skill and perform real text edit and generated-object move, undo, explicit save/discard and reopen on that exact PPTX. Record artifact SHA-256 and preserve review-required provenance. If no generated asset is accepted, do not substitute unrelated text/backing WPS proof.
- [ ] Write a final gate table with offline checks, each live provider, natural selection, generated-layer quality, offline rebuild, WPS and release state. If any required gate fails, keep release blocked and record concrete reason/evidence. Commit evidence only after sanitization. Merge, push, tag, npm publication and cache installation require separate direction.

## Plan self-review and handoff

Spec coverage: request/hole/context → Task 1; source-local qualification and frozen calibration → Task 2; final invariants/provenance → Task 3; bounded diagnostics/atomicity/v2 compatibility → Task 4; independent review/live routing/editor/release boundaries → Task 5. Shared type names are defined above; evidence/geometry helpers already in `complete.ts` remain authoritative.

Recommended execution is fresh implementer per task with independent task review and final whole-branch review in this same Codex task. Inline checkpointed execution is available if requested. This document is a plan, not evidence that any task has been implemented or accepted.
