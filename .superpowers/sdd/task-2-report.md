# Task 2 Report: Plan Fidelity Candidates Without Rebuilding Structural Furniture

## Status

Complete. Commits `fbbe8d1` (`feat: plan fidelity-first slide candidates`) and `a93849d` (`fix: keep minor artwork in slide background`).

## Implementation summary

- Added fidelity-plan contract types without changing `SlideManifestSchema` or manifest version 1.
- Added `planFidelityCandidates(ocr, vision)` with OCR-derived text candidates marked `required: true`.
- Restricted Vision-derived candidates to bitmap `icon` and `illustration` elements.
- Used panels only as grouping scopes; panels, bars, shapes, borders, photos, and backgrounds are never fidelity candidates.
- Grouped bitmap candidates whose centers fall inside the same panel, retaining source indexes, union bounds, highest z-index, and deterministic labels/IDs.
- Clipped OCR and visual candidates to the 1280x720 canvas before grouping, omitted fully non-intersecting visuals, and emitted `out_of_bounds_clipped` at most once.

## TDD evidence

### RED 1: missing candidate planner

Command:

```sh
node --import tsx --test tests/fidelity-candidates.test.ts
```

Result: exit 1. Node reported `ERR_MODULE_NOT_FOUND` for `src/fidelity/candidates.js`, the expected failure before production implementation existed.

### GREEN 1: base candidate planning

Command:

```sh
node --import tsx --test tests/fidelity-candidates.test.ts
```

Result: exit 0; 1 test passed, 0 failed.

### RED 2: clipping before grouping

Command:

```sh
node --import tsx --test tests/fidelity-candidates.test.ts
```

Result: exit 1; 1 passed, 1 failed. The clipping case expected one retained visual candidate but received two (`2 !== 1`), demonstrating that the fully outside visual had not yet been omitted.

### GREEN 2 and focused regression

Command:

```sh
node --import tsx --test tests/fidelity-candidates.test.ts tests/planner.test.ts
```

Result: exit 0; 13 tests passed, 0 failed.

### Type check

Command:

```sh
npm run lint:types
```

Result: exit 0; TypeScript emitted no errors.

### Full source suite before commit

Command:

```sh
npm test
```

Result: exit 0; 83 tests passed, 0 failed.

## Files

- `src/contracts.ts`: fidelity candidate and plan types.
- `src/fidelity/candidates.ts`: candidate planning, panel grouping, and clipping.
- `tests/fidelity-candidates.test.ts`: structural-furniture exclusion/grouping and clipping coverage.

No provider files or unrelated source files were changed.

## Self-review

- Confirmed the candidate filter requires both `editableAs === "bitmap"` and a type of `icon` or `illustration`; structural Vision elements cannot enter `icons`.
- Confirmed panels are only consulted for center-based grouping and are never emitted.
- Confirmed original Vision indexes survive clipping/filtering; indexes retain source order within each panel group and within the ungrouped sequence, while grouped candidates are emitted before ungrouped candidates rather than preserving one global order.
- Confirmed clipping occurs before panel containment and union calculations.
- Confirmed OCR text planning remains independent of Vision by calling `planSlide(ocr, { elements: [] })`.
- Confirmed manifest v1 schema and existing output contracts are unchanged.
- Ran `git diff --check` before commit with no whitespace errors.

## Concerns

- The canvas-clipping algorithm is intentionally duplicated from `planner.ts` to keep changes within the brief's allowed files. A later scoped refactor could share it, but doing so here would enlarge the change surface.
- Git reported that committer identity was auto-configured from the local username and hostname; this does not affect the implementation or tests.

## Review fix: conservative major-candidate gate

### Implementation

- Added named thresholds requiring confidence >= 0.80, clipped width and height >= 24 px, and clipped area >= 1600 px².
- Applied the gate before panel grouping so small decorations and uncertain illustrations stay in the background.
- Added a regression proving a high-confidence 20x20 decorative icon and a low-confidence 200x200 illustration are excluded while the wrench/shield group remains unchanged.
- Added a real `qwen-ocr-slide-07.json` regression proving exactly 10 text candidates are planned and all are required.
- Updated the clipping regression's retained icon so its clipped 40x50 box remains a valid major candidate under the confirmed product policy.

### Fix RED

Command:

```sh
node --import tsx --test tests/fidelity-candidates.test.ts
```

Result: exit 1; 3 tests passed, 1 failed. `keeps decorative and uncertain bitmaps in the background` expected one icon group but received two (`2 !== 1`), proving the prior filter still admitted non-major bitmaps. The slide-7 fixture regression passed with exactly 10 required text candidates.

### Fix GREEN and focused regression

Command:

```sh
node --import tsx --test tests/fidelity-candidates.test.ts tests/planner.test.ts
```

Result: exit 0; 15 tests passed, 0 failed.

### Fix type check

Command:

```sh
npm run lint:types
```

Result: exit 0; TypeScript emitted no errors.

### Fix self-review

- Verified all three thresholds are conjunctive and use the clipped bbox, intentionally favoring false negatives.
- Verified the existing major wrench/shield panel group still uses original source indexes `[1, 2]`.
- Verified no provider, contract, or unrelated source file changed in the review fix.
- Corrected the earlier report's over-broad global-order claim.
