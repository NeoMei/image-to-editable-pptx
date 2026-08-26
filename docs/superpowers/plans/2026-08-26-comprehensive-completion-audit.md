# Comprehensive Completion Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-audit the fidelity-first image-to-editable-PPT system until its task contract, production code, automated behavior, generated Slide 7 artifact, and real WPS interactions have no remaining actionable defects.

**Architecture:** Treat the repository as a CLI/backend pipeline whose user-facing UI is the generated PPTX opened in WPS. Audit in three independent passes: requirements/data-flow correctness, adversarial implementation boundaries, and end-to-end artifact/UI behavior. Every production fix must begin with a failing regression test and end with focused plus full verification.

**Tech Stack:** Node.js 22.6+, TypeScript 5.9, Sharp 0.35.3, Zod 4, PptxGenJS 4.0.1, Node test runner, ZIP/OOXML inspection, WPS Office macOS.

## Global Constraints

- Preserve the fidelity-first policy: exactly ten editable OCR text layers; only verified transparent icons; panels, bars, borders, shadows, texture, and uncertain icons remain in the background.
- Do not make live Alibaba or Wanx calls during this audit; use the recorded Slide 7 analysis for rebuilds.
- Never expose the configured API key, workspace ID, authorization strings, signed URLs, or provider-secret headers in commands, reports, fixtures, artifacts, or Git.
- Do not modify `main`, push, publish, or merge. Work only on `feature/enhanced-prototype` in the existing linked worktree.
- Use TDD for every behavior change: RED focused regression, minimum fix, GREEN focused regression, then full source/compiled/type/build verification.
- A successful audit requires three passes with no unresolved Critical, Important, or worthwhile Minor issue.

---

### Task 1: Reconcile the Original Plan, Design, and Delivered Evidence

**Files:**
- Read: `docs/superpowers/specs/2026-08-25-fidelity-first-layering-design.md`
- Read: `docs/superpowers/plans/2026-08-25-fidelity-first-layering.md`
- Read: `.superpowers/sdd/task-2-report.md`, `.superpowers/sdd/task-3-report.md`, `.superpowers/sdd/fidelity-final-fix-report.md`
- Inspect: `output/slide-07-final-fix/manifest.json`, `analysis-ledger.json`, `run-ledger.json`, `.image-ppt-layers-output.json`
- Update: `.superpowers/sdd/comprehensive-audit-report.md`

**Interfaces:**
- Consumes: the eight-task implementation plan and the final Slide 7 output tree.
- Produces: a requirement-by-requirement matrix with evidence paths and explicit pass/fail status.

- [x] **Step 1: Enumerate every binding invariant from the design and plan**

Run:

```bash
rg -n "must|must not|exactly|required|reject|preserve|不得|必须|恰好|失败|保留" docs/superpowers/specs/2026-08-25-fidelity-first-layering-design.md docs/superpowers/plans/2026-08-25-fidelity-first-layering.md
```

- [x] **Step 2: Reconcile the output tree and ledger**

Run a local Node/JSON inspection that proves 10 text elements, 4 transparent assets, 0 shapes, 15 decisions, 0 warnings, empty task IDs, only OCR/Vision models, and byte hashes matching every ledger entry.

- [x] **Step 3: Inspect Git history and reports for incomplete tasks**

Run:

```bash
git log --oneline --reverse main..HEAD
git status --short
```

Expected: all eight task commits and their review fixes are present; the worktree has only deliberate audit changes.

---

### Task 2: First-Pass Production Code and Data-Flow Review

**Files:**
- Review: `src/cli.ts`, `src/config.ts`, `src/contracts.ts`, `src/pipeline.ts`, `src/recording.ts`
- Review: `src/providers/*.ts`, `src/fidelity/*.ts`, `src/image/*.ts`, `src/export/pptx.ts`, `src/acceptance/text-span.ts`
- Test: the matching files under `tests/`

**Interfaces:**
- Consumes: CLI arguments, local image/analysis files, provider responses, and filesystem paths.
- Produces: owned atomic output directories, sanitized evidence, fidelity manifest, PPTX, and ledger.

- [x] **Step 1: Trace entrypoints to publication**

Inspect argument parsing, credential loading, analyze/build/run dispatch, staging ownership, canonical path checks, backup promotion, failed-run retention, and final ledger creation.

- [x] **Step 2: Trace untrusted data and filesystem boundaries**

Inspect schema bounds, non-finite geometry, JSON recursion/string/node budgets, prototype-related object behavior, symlinks, aliases, source/output overlap, provider endpoint pinning, redirects, and signed-result URL handling.

- [x] **Step 3: Trace fidelity behavior**

Inspect text candidate priority, glyph-mask safety, outside-mask invariance, local-repair thresholds, transparent extraction, asset-mask clipping, recomposition gates, text style/tracking, PPTX z-order, and exact 10-text publication checks.

- [x] **Step 4: Fix each confirmed issue with a RED/GREEN regression**

For each confirmed issue, add one focused test to the matching `tests/*.test.ts`, run it to observe the expected failure, apply the smallest production fix with `apply_patch`, rerun the focused test, then run `npm test`.

---

### Task 3: Automated and Adversarial System Test Pass

**Files:**
- Test: all `tests/*.test.ts`
- Build: `dist/`
- Inspect: `scripts/accept-slide-07.sh`, `scripts/measure-text-span.ts`

**Interfaces:**
- Consumes: deterministic fixtures and generated synthetic images.
- Produces: source-test, compiled-test, typecheck, build, CLI failure/success, and security-boundary evidence.

- [x] **Step 1: Run the standard full gate**

```bash
npm test
npm run lint:types
npm run build
npm run test:compiled
git diff --check
```

- [x] **Step 2: Run CLI and publication adversarial cases**

Verify missing/unknown/duplicate arguments, required-text-count bounds, absent credentials for live commands, credential-free offline build, unowned output refusal, symlink and ancestor rejection, failed-run retention, stale-artifact removal, and exact-text atomicity.

- [x] **Step 3: Scan committed and generated material for secrets and live-network evidence**

Search production sources, reports, final output, and Git diff for credential shapes, authorization values, signed query keys, task IDs, and unexpected Wanx/default-path references. Synthetic test canaries must remain confined to tests.

---

### Task 4: Offline Rebuild, OOXML, Visual, and Real WPS UI Pass

**Files:**
- Source: `/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png`
- Analysis: `output/slide-07`
- Output: `output/slide-07-comprehensive-audit/`
- UI copy: `.codex-tmp/comprehensive-audit/wps-smoke/slide-07-editable-smoke.pptx`

**Interfaces:**
- Consumes: the unchanged source PNG and recorded OCR/Vision analysis.
- Produces: a new byte-reconciled PPTX plus machine and WPS interaction evidence.

- [x] **Step 1: Rebuild with an empty credential environment**

```bash
env -i PATH=/usr/local/bin:/usr/bin:/bin npm run cli -- build --image '/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png' --analysis output/slide-07 --out output/slide-07-comprehensive-audit --required-text-count 10
```

Expected: exit 0 with no network or credential access.

- [x] **Step 2: Inspect OOXML and render evidence**

Verify 10 editable text objects, 4 transparent assets, 1 background, correct z-order/names, no structural shape layers, 9 tracked runs, no canvas overflow, no one-line title/banner wrapping, and 10/10 source-backed span/anchor acceptance.

- [x] **Step 3: Perform real WPS interaction smoke on a byte-identical copy**

Open the copied PPTX in WPS, confirm the exact window/document, edit the title and bottom slogan, move one accepted icon, confirm the exposed background is clean, undo every change, close with explicit `不保存`, and prove the smoke copy and deliverable hashes remain unchanged.

---

### Task 5: Second and Third Independent Review Passes

**Files:**
- Review: complete `main...HEAD` diff and every changed production/test/report file.
- Update: `.superpowers/sdd/comprehensive-audit-report.md`

**Interfaces:**
- Consumes: the post-fix branch and fresh end-to-end evidence.
- Produces: two independent review sections with issue severity and disposition.

- [x] **Step 1: Second pass from adversarial inputs and failure recovery**

Review parser ambiguity, object/prototype edge cases, filesystem race windows, abort/timeouts, partial writes, hash mismatch behavior, corrupt artifacts, extreme geometry, and fidelity threshold inclusivity. TDD-fix every confirmed issue and repeat Tasks 3–4 if production behavior changes.

- [x] **Step 2: Third pass from user-visible fidelity and maintainability**

Review the complete slide at full resolution, editability semantics, font substitution, text wrapping, source/render alignment, icon transparency, background seams, documentation accuracy, test independence, deterministic output, and absence of slide-string/ID special cases beyond the explicit acceptance count. TDD-fix every confirmed issue and repeat Tasks 3–4 if production behavior changes.

- [x] **Step 3: Final completion gate**

Reread the design and plan line-by-line, confirm every checklist row has current evidence, run the entire standard gate again, verify a clean Git diff, commit the audit fixes/report, and record final HEAD and artifact hash.
