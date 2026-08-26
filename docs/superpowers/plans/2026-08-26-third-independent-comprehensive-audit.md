# Third Independent Comprehensive Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independently re-audit the full fidelity-first image-to-editable-PPT system, repair every newly proven defect, and finish with fresh automated, artifact, and WPS UI evidence.

**Architecture:** Reuse the existing isolated `feature/enhanced-prototype` worktree. Review the system in three independent passes: requirements/publication integrity, provider/image/fidelity integrity, and clean rebuilt artifact/UI behavior. Every production fix must begin with a failing regression test, then receive a minimal root-cause patch and focused/full verification.

**Tech Stack:** Node.js 22.6+, TypeScript 5.9, Sharp 0.35.3, Zod 4, PptxGenJS 4.0.1, Node test runner, OOXML/ZIP inspection, bundled presentation renderer, WPS Office macOS.

## Global Constraints

- Work only in the existing linked worktree on `feature/enhanced-prototype`; do not modify `main`, push, publish, merge, or call live provider APIs.
- Rebuild from the recorded `output/slide-07` analysis with provider credentials absent.
- Preserve the accepted product boundary: prioritize ten editable text layers and visual fidelity; split only demonstrably safe major icons; retain panels, bars, texture, and uncertain graphics in the background.
- Never print, persist, or commit user credentials, signed URLs, provider headers, or workspace authorization values.
- A bug fix is acceptable only after RED -> minimal root-cause fix -> focused GREEN -> full source and compiled regression.
- Completion requires repeated code-path review, clean-install tests, byte-level ledger/OOXML reconciliation, full-resolution render inspection, and exact-file WPS edit/move/undo/discard/reopen evidence.

---

### Task 1: Re-establish the baseline and requirement matrix

**Files:**
- Read: `package.json`, `package-lock.json`, `.gitignore`
- Read: `docs/superpowers/specs/2026-08-25-fidelity-first-layering-design.md`
- Read: `docs/superpowers/plans/2026-08-25-fidelity-first-layering.md`
- Read: `.superpowers/sdd/independent-second-audit-report.md`

**Interfaces:**
- Consumes: current branch, original design, dependency lock, and prior evidence only as hypotheses.
- Produces: a fresh baseline and an independently checked requirement-to-code/test matrix.

- [x] **Step 1: Prove branch and worktree state**

```bash
git branch --show-current
git status --short --branch
git log --oneline --reverse main..HEAD
```

Expected: `feature/enhanced-prototype`, clean worktree before this plan, and no main-branch mutation.

- [x] **Step 2: Run the clean baseline**

```bash
npm ci
npm test
npm run lint:types
npm run build
npm run test:compiled
```

Expected: source and compiled tests have zero failures; types/build exit 0.

- [x] **Step 3: Map every binding requirement**

```bash
rg -n "must|must not|exactly|required|reject|preserve|不得|必须|恰好|失败|保留" docs/superpowers/specs/2026-08-25-fidelity-first-layering-design.md docs/superpowers/plans/2026-08-25-fidelity-first-layering.md
```

Expected: each rule has a source path, automated test, artifact check, or explicit WPS acceptance step.

---

### Task 2: Review pass one - state, provenance, ledger, and publication integrity

**Files:**
- Review/modify if proven: `src/contracts.ts`, `src/pipeline.ts`
- Test: `tests/contracts.test.ts`, `tests/pipeline.test.ts`, `tests/publication.test.ts`

**Interfaces:**
- Consumes: source bytes, recorded analysis, fidelity results, staging paths, ownership markers.
- Produces: a self-consistent manifest/decision/assets ledger and safe terminal filesystem state.

- [x] **Step 1: Trace all success and failure states**

```bash
rg -n "analyzeSlide|buildSlide|runPipeline|buildFromAnalysis|decisions|assets|manifest|promoteSuccessfulRun|retainFailedRun|validatePublicationTarget" src tests
```

Check parse failure, provenance mismatch, fidelity failure, untracked assets, duplicate IDs, contradictory decisions, export failure, rollback, retention, and owned rerun replacement.

- [x] **Step 2: Add one minimal RED test for each confirmed invariant gap**

Example required behavior for an untracked fidelity asset:

```typescript
await assert.rejects(
  runPipeline({ imagePath, outDir, replay, fidelityBuild: buildWithOrphanAsset }),
  /Fidelity result contains an untracked asset/,
);
```

Run the exact test name and require an assertion failure showing the current pipeline incorrectly publishes the result.

- [x] **Step 3: Implement and verify the smallest integrity validator**

Validate that candidate decisions, manifest elements, and in-memory assets are one-to-one and cross-field consistent before writing or publishing. Run focused source tests, then build and run the compiled equivalents.

---

### Task 3: Review pass two - hostile provider, image, fidelity, and export boundaries

**Files:**
- Review: `src/providers/*.ts`, `src/recording.ts`, `src/image/*.ts`, `src/fidelity/*.ts`, `src/export/pptx.ts`, `src/acceptance/*.ts`
- Review: matching `tests/*.test.ts`

**Interfaces:**
- Consumes: provider payloads, paths, image bytes, geometry, masks, text styles, transparent assets.
- Produces: bounded normalized data, high-fidelity background, safe editable layers, deterministic PPTX.

- [x] **Step 1: Recheck trust boundaries and exact-byte provenance**

```bash
rg -n "fetch\(|redirect|Abort|timeout|safeParse|JSON.parse|readFile|sha256|realpath|MAX_|sanitize" src/providers src/recording.ts src/pipeline.ts tests
```

Require endpoint pinning, redirect refusal, bounded bodies, no credential leakage, regular-file checks, and hashes computed from the same bytes that are parsed or consumed.

- [x] **Step 2: Recheck pixel and layer invariants**

```bash
rg -n "outsideMaskChangedPixels|accepted|kept_in_background|transparent|overlap|recomposition|dilat|clip|font|charSpacing|zIndex" src/fidelity src/image src/export src/acceptance tests
```

Require canvas bounds, mask locality, alpha preservation, OCR priority, icon fallback, source-backed metrics, and deterministic z-order.

- [x] **Step 3: Run all focused suites and restart the pass after any fix**

```bash
node --import tsx --test tests/contracts.test.ts tests/pipeline.test.ts tests/publication.test.ts tests/qwen-ocr.test.ts tests/qwen-vision.test.ts tests/wanx-edit.test.ts tests/fidelity-build.test.ts tests/local-repair.test.ts tests/asset-mask.test.ts tests/recompose.test.ts tests/pptx.test.ts tests/text-span.test.ts
```

Expected: zero failures after every RED/GREEN repair cycle.

---

### Task 4: Review pass three - fresh artifact and real WPS UI

**Files:**
- Source: `/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png`
- Analysis: `output/slide-07/`
- Create: `output/slide-07-third-independent-audit/`
- Create: `.codex-tmp/third-independent-audit-wps-smoke/`

**Interfaces:**
- Consumes: unchanged source PNG and recorded analysis.
- Produces: new PPTX, reconciled hashes/OOXML/render/span evidence, and user-visible WPS interaction evidence.

- [x] **Step 1: Rebuild offline with empty credentials**

```bash
env -u DASHSCOPE_API_KEY -u ALIBABA_API_KEY -u ALIBABA_CLOUD_ACCESS_KEY_ID -u ALIBABA_CLOUD_ACCESS_KEY_SECRET npm run cli -- build --image '/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png' --analysis output/slide-07 --out output/slide-07-third-independent-audit --required-text-count 10
```

Expected: success with ten editable texts, only accepted transparent assets, no native shapes, and no live task IDs.

- [x] **Step 2: Reconcile bytes, OOXML, rendering, overflow, and text spans**

Require every ledger SHA-256 to equal the actual file, decision IDs to equal manifest IDs, OOXML object counts/names to match the manifest, `slides_test.py` to report zero overflow, text-span acceptance to be 10/10, and the 1280x720 render to preserve the source composition.

- [x] **Step 3: Exercise the exact copy in WPS**

Prove the smoke copy hash equals the generated artifact, open that exact file, edit the title and slogan, move a retained transparent icon, undo each change, explicitly choose `不保存`, reopen, and prove both content and SHA-256 remain unchanged.

---

### Task 5: Repeat all gates and record the final evidence

**Files:**
- Create: `.superpowers/sdd/third-independent-audit-report.md`
- Update: `.superpowers/sdd/progress.md`

**Interfaces:**
- Consumes: all review, test, artifact, and WPS evidence.
- Produces: auditable completion verdict, disclosed residual risks, clean commits, and branch handoff options.

- [x] **Step 1: Repeat the clean full gate**

```bash
npm ci
npm test
npm run lint:types
npm run build
npm run test:compiled
node --import tsx --test --experimental-test-coverage "tests/*.test.ts"
npm audit --json
git diff --check
```

Expected: functional gates pass. Dependency advisories, if any, are reported rather than hidden.

- [x] **Step 2: Repeat requirement, secret, and diff reviews**

```bash
git diff --stat main...HEAD
git grep -IlE 'sk-[A-Za-z0-9_-]{20,}|LTAI[A-Za-z0-9]{12,}|llm-[a-z0-9]{12,}' -- ':!tests/**' ':!package-lock.json'
git status --short
```

Expected: no real credential-shaped value outside synthetic tests; only intentional audit changes before commit.

- [x] **Step 3: Commit implementation separately from evidence and verify final HEAD**

Record every RED/GREEN finding, test count, artifact hash, WPS save/discard/reopen result, and residual advisory. Commit production/tests first when present, then plan/report/progress. Finish with a fresh `npm test` and clean worktree.
