# Independent Second Comprehensive Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independently re-verify the complete fidelity-first image-to-editable-PPT system from current HEAD, repair every newly confirmed actionable defect with TDD, and produce fresh code, artifact, and WPS evidence.

**Architecture:** Treat `src/cli.ts` through `src/pipeline.ts` as the backend/CLI path and the generated PPTX opened in WPS as the user-facing UI. Use three fresh passes with different review lenses: requirements and state transitions, hostile inputs and filesystem/provider boundaries, then clean-build artifact and real-client behavior. If a pass confirms a production defect, pause that pass, add a minimal failing regression, implement only the root-cause fix, and restart all affected gates.

**Tech Stack:** Node.js 22.6+, TypeScript 5.9, Sharp 0.35.3, Zod 4, PptxGenJS 4.0.1, Node test runner, OOXML/ZIP inspection, bundled presentation renderer, WPS Office macOS.

## Global Constraints

- Work only in the existing linked worktree on `feature/enhanced-prototype`; do not modify `main`, push, publish, or merge.
- Do not perform live Alibaba or Wanx calls. Rebuild only from `output/slide-07` recorded analysis with an empty credential environment.
- Never print, persist, or commit credentials, workspace IDs, authorization values, signed URLs, or provider-secret headers.
- Preserve the agreed fidelity policy: exactly 10 editable OCR text layers; only demonstrably safe transparent icons; panels, bars, borders, texture, and uncertain icons remain in the background.
- Every production behavior change must follow RED -> root-cause fix -> focused GREEN -> full source and compiled verification.
- Completion requires three review passes, fresh clean-install tests, byte-reconciled output, full-resolution visual inspection, and explicit WPS edit/undo/no-save evidence.

---

### Task 1: Establish a Clean, Reproducible Baseline

**Files:**
- Read: `package.json`, `package-lock.json`, `.gitignore`
- Read: `docs/superpowers/specs/2026-08-25-fidelity-first-layering-design.md`
- Read: `docs/superpowers/plans/2026-08-25-fidelity-first-layering.md`
- Read: `docs/superpowers/plans/2026-08-26-comprehensive-completion-audit.md`
- Read: `.superpowers/sdd/comprehensive-audit-report.md`

**Interfaces:**
- Consumes: current branch, dependency lock, original design and prior audit evidence.
- Produces: clean-install baseline, task-completion matrix, and current known-risk inventory.

- [x] **Step 1: Verify isolated branch and clean starting state**

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short
git log --oneline --reverse main..HEAD
```

Expected: linked worktree, branch `feature/enhanced-prototype`, no pre-existing uncommitted changes before this plan, and all original task/fix commits present.

- [x] **Step 2: Install exactly the lockfile dependency graph and run baseline tests**

```bash
npm ci
npm test
npm run lint:types
npm run build
npm run test:compiled
```

Expected: 154 source and 154 compiled tests, zero failures, typecheck/build exit 0.

- [x] **Step 3: Reconcile every original binding invariant**

```bash
rg -n "must|must not|exactly|required|reject|preserve|不得|必须|恰好|失败|保留" \
  docs/superpowers/specs/2026-08-25-fidelity-first-layering-design.md \
  docs/superpowers/plans/2026-08-25-fidelity-first-layering.md
```

Map each invariant to a current source path, test, ledger field, or WPS acceptance step; any unmapped invariant is a confirmed task gap.

---

### Task 2: Review Pass One — Requirements, State Transitions, and Publication

**Files:**
- Review: `src/cli.ts`, `src/config.ts`, `src/contracts.ts`, `src/pipeline.ts`, `src/recording.ts`
- Review: `tests/cli.test.ts`, `tests/config.test.ts`, `tests/contracts.test.ts`, `tests/pipeline.test.ts`, `tests/publication.test.ts`, `tests/recording.test.ts`

**Interfaces:**
- Consumes: CLI arguments, configuration, local source/analysis paths, staging output, ownership markers.
- Produces: validated analysis/build/run state transitions and atomic publication behavior.

- [x] **Step 1: Trace every command from parse to terminal filesystem state**

```bash
rg -n "parseArgs|analyzeSlide|buildSlide|runPipeline|validatePublicationTarget|publish|retainFailedRun|writeOwnershipMarker" src tests
```

Inspect success, parse failure, provider failure, fidelity failure, export failure, backup rollback, failed-run retention, and rerun replacement paths.

- [x] **Step 2: Exercise CLI and publication adversarial tests**

```bash
node --import tsx --test tests/cli.test.ts tests/pipeline.test.ts tests/publication.test.ts tests/recording.test.ts tests/response-observer.test.ts
```

Expected: missing/duplicate/unknown options, required-text mismatch, unowned paths, ancestor aliases, marker symlinks, failed-root symlinks, recording symlinks, malformed responses, and failed reruns all fail safely.

- [x] **Step 3: Apply the TDD gate to any confirmed finding**

For each finding: add one minimal regression in the matching existing test file; run only that file and observe the intended assertion failure; trace the failing value to its source; patch only that source with `apply_patch`; rerun the focused file to green. Do not change production code if no test can demonstrate the defect.

---

### Task 3: Review Pass Two — Provider, Parsing, Image, and Fidelity Boundaries

**Files:**
- Review: `src/providers/*.ts`, `src/image/*.ts`, `src/fidelity/*.ts`, `src/acceptance/*.ts`, `src/export/pptx.ts`
- Review: matching `tests/*.test.ts` files and provider fixtures.

**Interfaces:**
- Consumes: provider bodies, untrusted geometry, source pixels, masks, extracted assets, text styles.
- Produces: bounded normalized data, safe repairs, transparent assets, editable text, and ordered PPTX layers.

- [x] **Step 1: Recheck parser and provider security boundaries**

```bash
rg -n "fetch\(|Abort|timeout|redirect|URL\(|safeParse|JSON.parse|sanitize|MAX_|task_id|workspace|apiKey" src/providers src/recording.ts tests
```

Review endpoint pinning, credential timing, redirect refusal, signed-result URL allowlists, response truncation, recursive limits, normalized secret aliases, malformed JSON, non-finite geometry, and timeout classification.

- [x] **Step 2: Recheck pixel and fidelity invariants**

```bash
rg -n "outsideMaskChangedPixels|accepted|kept_in_background|transparent|overlap|recomposition|dilat|clip|font|charSpacing|zIndex" src/fidelity src/image src/export src/acceptance tests
```

Verify exact/inclusive thresholds, canvas-edge clipping, alpha preservation, no outside-mask mutation, OCR priority, icon fallback, source-backed text metrics, and deterministic z-order.

- [x] **Step 3: Run focused provider/fidelity tests and apply the TDD gate**

```bash
node --import tsx --test \
  tests/qwen-ocr.test.ts tests/qwen-vision.test.ts tests/wanx-edit.test.ts \
  tests/fidelity-plan.test.ts tests/fidelity-build.test.ts tests/local-repair.test.ts \
  tests/asset-mask.test.ts tests/transparent-extract.test.ts tests/recomposition.test.ts \
  tests/pptx-export.test.ts tests/text-span.test.ts
```

Expected: all focused suites pass. Any newly confirmed production defect follows the same RED/root-cause/GREEN sequence before continuing.

---

### Task 4: Review Pass Three — Clean Rebuild, OOXML, Visual, and WPS UI

**Files:**
- Source: `/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png`
- Analysis: `output/slide-07/`
- Create: `output/slide-07-independent-second-audit/`
- Create: `.codex-tmp/independent-second-audit/`

**Interfaces:**
- Consumes: unchanged source PNG and recorded OCR/Vision evidence.
- Produces: a fresh PPTX, ledger/hash reconciliation, render/overflow/span evidence, and WPS editability evidence.

- [x] **Step 1: Rebuild without credentials or network authorization**

```bash
env -i PATH=/usr/local/bin:/usr/bin:/bin npm run cli -- build \
  --image '/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png' \
  --analysis output/slide-07 \
  --out output/slide-07-independent-second-audit \
  --required-text-count 10
```

Expected: exit 0; 10 text, 4 transparent assets, 0 shapes, 15 decisions, 0 warnings, empty task IDs, and private JSON evidence.

- [x] **Step 2: Reconcile OOXML, hashes, overflow, and visual fidelity**

Use the bundled presentation runtime to render the PPTX and run `slides_test.py`; resize the render to 1280x720; run `npm run measure:text-span`; inspect the full-size render. Require 14 accepted IDs matching 14 manifest elements, every ledger hash matching bytes, one background plus four assets plus ten text objects in OOXML, zero overflow, and 10/10 text-span acceptance.

- [x] **Step 3: Perform exact-file WPS smoke**

Copy the fresh PPTX to `.codex-tmp/independent-second-audit/wps-smoke/`, prove identical SHA-256, open that exact copy in WPS, replace the main title and bottom slogan with temporary strings, move the accepted eye/radar icon, inspect the exposed background, undo all edits, close with explicit `不保存`, and prove both hashes are still identical.

---

### Task 5: Final Repetition, Dependency Review, and Handoff

**Files:**
- Create: `.superpowers/sdd/independent-second-audit-report.md`
- Update: `.superpowers/sdd/progress.md`
- Review: complete `main...HEAD` diff, generated report, and final output.

**Interfaces:**
- Consumes: all three review passes and fresh UI/artifact evidence.
- Produces: final completion verdict, disclosed residual risks, clean commits, and branch handoff options.

- [x] **Step 1: Repeat the full gate from a clean install**

```bash
npm ci
npm test
npm run lint:types
npm run build
npm run test:compiled
npm audit --json
git diff --check
```

Expected: tests/type/build/diff pass. Record all audit findings; never claim zero dependency advisories if npm reports otherwise.

- [x] **Step 2: Repeat requirements and secret scans**

```bash
git diff --stat main...HEAD
git status --short
git grep -IlE 'sk-[A-Za-z0-9_-]{20,}|LTAI[A-Za-z0-9]{12,}|llm-[a-z0-9]{12,}' -- ':!tests/**' ':!package-lock.json'
```

Expected: no credential-shaped value outside synthetic tests; only intentional audit changes remain before commit.

- [x] **Step 3: Record evidence, commit, and verify final HEAD**

Write the requirement matrix, every RED/GREEN fix, test counts, artifact hash, WPS save/discard outcome, and dependency residuals to the audit report. Commit implementation changes separately from final evidence when production fixes exist; otherwise commit only the new audit plan/report. Finish with a clean worktree, fresh `npm test`, and the structured branch options required by `finishing-a-development-branch`.
