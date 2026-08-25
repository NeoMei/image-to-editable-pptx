# Final Branch Review Fix Report

- Branch: `feature/enhanced-prototype`
- Starting head: `680aee35a10f0b40672e57193a708e6d707ca233`
- Implementation commit: `45fca76` (`fix: address final prototype review findings`)
- Network policy: no live API calls were made. Provider and pipeline tests used mocked `fetch`, replay fixtures, and injected inpainting.

## Finding-by-finding TDD evidence

### 1. OCR advanced recognition and coordinate envelope

- RED: `npm test -- tests/qwen-ocr.test.ts` exited 1. The request still sent `text_recognition`, and the coordinate-free real-envelope regression received only the old generic `Invalid Qwen OCR response` error.
- GREEN: `npm test -- tests/qwen-ocr.test.ts tests/qwen-vision.test.ts` passed 11/11. The request now sends `advanced_recognition`; the parser accepts `ocr_result.words_info[]` and explicitly rejects the coordinate-free `text_recognition` envelope.
- Files: `src/providers/qwen-ocr.ts`, `tests/qwen-ocr.test.ts`, `README.md`, both approved design/plan documents.

### 2. Background candidate exclusion

- RED: `npm test -- tests/planner.test.ts` exited 1. Two full-canvas candidates (`type=background` and `editableAs=background`) became bitmap assets and generated a full-page white removal mask.
- GREEN: `npm test -- tests/planner.test.ts tests/mask.test.ts tests/pptx.test.ts tests/extract.test.ts` passed 20/20. Both background contracts are removed before foreground planning; the regression sees an empty manifest and an all-black mask.
- Files: `src/planner.ts`, `tests/planner.test.ts`, design and README behavior notes.

### 3. Standalone build transaction and analyze output contract

- RED: `npm test -- tests/pipeline.test.ts` exited 1. Failed standalone build changed the owned success, successful smaller build retained six stale assets/recordings, and standalone analyze accepted a non-empty directory.
- GREEN: `npm test -- tests/pipeline.test.ts` passed 11/11 at the transaction checkpoint. Standalone build now uses sibling staging, the existing ownership-validated promote/backup path, and failed-run retention. A smaller success replaces the complete directory. Standalone analyze requires a new or empty non-symlink directory.
- Files: `src/pipeline.ts`, `tests/pipeline.test.ts`, `README.md`, implementation plan.

### 4. Wanx result URL validation

- RED: `npm test -- tests/wanx-edit.test.ts` exited 1 because an HTTP result URL was downloaded instead of rejected.
- GREEN: final `npm test -- tests/wanx-edit.test.ts` passed 12/12. Tests cover malformed URLs, HTTP, userinfo, non-default port, fragment, IPv4/IPv6 literals, localhost, unrelated domains, deceptive suffixes, the documented DashScope OSS family, and redirect rejection with `redirect: error`.
- Files: `src/providers/wanx-edit.ts`, `tests/wanx-edit.test.ts`, `README.md`, implementation plan.

### 5. Complete slide-7 native-shape acceptance

- RED: planner and PPTX tests failed because native shapes discarded their semantic labels and XML names contained only generated IDs.
- GREEN: the expanded 13-element Vision fixture contains seven independently recolorable native structures and six bitmap assets. Planner/pipeline assertions require the exact labels `top section label`, `orange subtitle bar`, `bottom navy bar`, four content-panel labels, and verify those labels appear in `shape-*` PPTX XML names rather than `asset-*` names.
- Files: `tests/fixtures/qwen-vision-slide-07.json`, `tests/qwen-vision.test.ts`, `tests/planner.test.ts`, `tests/pipeline.test.ts`, `src/contracts.ts`, `src/planner.ts`, `src/export/pptx.ts`, `tests/pptx.test.ts`, `tests/mask.test.ts`.

### 6. Invalid raw provider response retention

- RED: `npm test -- tests/pipeline.test.ts` failed because malformed OCR/Vision staging runs had no `raw-responses/<provider>.json` or `parse-errors/<provider>.json`.
- GREEN: the provider-boundary observer writes the response before normalization and writes a fixed parse-error record on failure. The live analysis waits for both provider promises to settle before failed staging is moved, preventing a write/rename race. Malformed OCR and Vision regressions retain both files and prove API-key, Authorization, Bearer, and DashScope-header canaries are absent.
- Files: `src/providers/response-observer.ts`, `src/providers/qwen-ocr.ts`, `src/providers/qwen-vision.ts`, `src/pipeline.ts`, `tests/pipeline.test.ts`, `README.md`, both design/plan documents.

### 7. Below-five-percent transparency fallback

- RED: not applicable to production behavior. The review finding was missing direct coverage; the existing implementation already contained the exact fallback branch, so the new test passed on its first run.
- GREEN/baseline proof: `npm test -- tests/extract.test.ts` passed 5/5. A 100x100 crop with a one-pixel connected cream perimeter (396/10,000 pixels) returns exact reason `transparent_pixel_ratio_below_5_percent`, remains rectangular, and has pixels identical to the source crop.
- Files: `tests/extract.test.ts` only.

### 8. Deterministic adjacent OCR line merge

- RED: `npm test -- tests/planner.test.ts` failed with `2 !== 1` for the positive paragraph case.
- GREEN: aligned adjacent lines now merge with an exact newline and coordinate union; distance, horizontal shift, and font-size-ratio negative cases remain separate. Rule: non-negative vertical gap up to 75% of the smaller line height (minimum 4 px), left-edge delta up to 50% of the smaller estimated font size (minimum 4 px), estimated font-size ratio at most 1.2.
- Files: `src/planner.ts`, `tests/planner.test.ts`, `README.md`, both design/plan documents.

## Verification commands and results

1. Required TDD skill read completely before edits: `/Users/neomei/.agents/skills/test-driven-development/SKILL.md`.
2. RED commands:
   - `npm test -- tests/qwen-ocr.test.ts` -> exit 1, 2 expected failures.
   - `npm test -- tests/planner.test.ts` -> exit 1, 4 expected failures.
   - `npm test -- tests/wanx-edit.test.ts` -> exit 1, unsafe URL accepted.
   - `npm test -- tests/pipeline.test.ts` -> exit 1, 6 expected failures.
   - `npm test -- tests/pptx.test.ts` -> exit 1, semantic shape name absent.
   - `npm test -- tests/extract.test.ts` -> exit 0, 5/5; coverage-only finding 7 already behaved correctly.
3. Focused GREEN commands:
   - `npm test -- tests/qwen-ocr.test.ts tests/qwen-vision.test.ts` -> 11/11 pass.
   - `npm test -- tests/planner.test.ts tests/mask.test.ts tests/pptx.test.ts tests/extract.test.ts` -> 20/20 pass.
   - `npm test -- tests/pipeline.test.ts` -> 11/11 pass.
   - final `npm test -- tests/qwen-ocr.test.ts tests/pipeline.test.ts` -> 16/16 pass.
   - final `npm test -- tests/wanx-edit.test.ts` -> 12/12 pass.
4. `npm run lint:types` -> exit 0.
5. `npm run build` -> exit 0.
6. Final `npm test` after rebuilding ignored `dist` -> exit 0, 148/148 pass (74 source tests plus the matching 74 compiled tests discovered by Node).
7. `bash -n scripts/accept-slide-07.sh` -> exit 0.
8. `git diff --check` -> exit 0.
9. Credential-shaped secret scan over the diff -> no matches.
10. Placeholder scan over `src`, `tests`, `README.md`, `docs`, and `scripts` (excluding generated `dist`) -> no unresolved placeholders.

## Self-review and concerns

- Self-review checked every finding against the final code path and confirmed transaction ownership/canonical-path checks were reused rather than bypassed.
- The first full `npm test` attempt saw three failures only from stale ignored `dist/tests` left by an older compile. `npm run build` refreshed that generated tree, after which the full suite passed 148/148. `dist` remains ignored and is not part of the commit.
- No real Alibaba credentials were available, so `advanced_recognition`, the documented OSS hostname family, and malformed-response retention are verified against official-contract-shaped offline envelopes and mocked transport, not a live authenticated request.
- Finding 7 changed tests only because production behavior was already correct.

---

## Round 2 final review fixes

- Starting head: `ca91dddef99ccc5f7de94026d48a61ce8a1c31aa`
- Implementation commit: `f94a9c4` (`fix: address second final review findings`)
- Network policy: no live API calls were made. Provider tests used mocked `fetch`; pipeline tests used sanitized fixtures and injected local inpainting.
- Source inspection: the required 1280×720 `source-slide-07.png` was opened at original detail before choosing geometry. It shows the orange bar at approximately `(135,162)..(1159,218)`, bottom navy bar at `(42,607)..(1240,689)`, three main panels, and two separate right-side panels with a visible gap.

### Round 2 finding-by-finding TDD evidence

#### R2-1. Representative font size for merged OCR lines

- RED: `npm test -- tests/planner.test.ts tests/mask.test.ts tests/qwen-vision.test.ts` exited 1; the merged two-line paragraph used the union bbox and produced `39.6 px` instead of the expected representative `17.64 px`.
- GREEN: the planner retains each source line's clamped estimate and uses their median after merging. The positive two-line regression is `17.64 px`; distance, alignment, and size-mismatch negative cases retain their independent estimates. The PowerPoint exporter still explicitly uses `fit: "none"`.
- Files: `src/planner.ts`, `tests/planner.test.ts`, approved design/implementation documents.

#### R2-2. Slide-7 semantic-shape geometry

- RED: the same focused RED command reported four fixture/geometry failures: only seven shapes existed; the right-side panels were bridged; the event panel was absent from fixture/planner acceptance; the fixture had 13 rather than 14 total elements.
- GREEN: the inspected fixture now has eight native structures and six bitmap assets. Tests assert exact bboxes/radii, all labels in the manifest, the two right panels' black mask gap, and every semantic `shape-*` name in PPTX XML. Chosen bars are `(135,162,1024,56)` and `(42,607,1198,82)`.
- Files: `tests/fixtures/qwen-vision-slide-07.json`, `tests/qwen-vision.test.ts`, `tests/planner.test.ts`, `tests/mask.test.ts`, `tests/pipeline.test.ts`, approved design/implementation documents.

#### R2-3. Malformed outer HTTP response retention

- RED: `npm test -- tests/pipeline.test.ts` exited 1 with 10/13 passing. Literal invalid-JSON bodies for OCR and Vision escaped as SDK/native `SyntaxError`s and produced neither a bounded raw-body recording nor the required stable parse-error record.
- GREEN: OCR reads text before `JSON.parse`; Vision's constrained fetch clones and reads the body before SDK decoding. Both paths save a maximum 65,536-character sanitized body with `originalLength`/`truncated`, redact the configured key plus assignment/Bearer/`sk-`/`LTAI` credential shapes, save a provider parse error, and retain both files under the failed staging run. Existing valid-outer/invalid-inner regressions remain green; recording still rejects executable payload methods.
- Files: `src/providers/response-observer.ts`, `src/providers/qwen-ocr.ts`, `src/providers/qwen-vision.ts`, `src/pipeline.ts`, `tests/pipeline.test.ts`, approved design document.

#### R2-4. Source-only and compiled test scopes

- RED: `npm test -- tests/package-scripts.test.ts` exited 1 because `npm test` had no source-tree selector and rediscovered ignored compiled tests.
- GREEN: `npm test` targets only `tests/*.test.ts`; `npm run test:compiled` separately targets `dist/tests/*.test.js`. README and the implementation plan document the split. Logical source count is 78, not a combined source-plus-compiled count.
- Files: `package.json`, `tests/package-scripts.test.ts`, `README.md`, approved implementation plan.

### Round 2 verification commands and results

1. Required TDD skill read completely before edits: `/Users/neomei/.agents/skills/test-driven-development/SKILL.md`.
2. RED:
   - `npm test -- tests/planner.test.ts tests/mask.test.ts tests/qwen-vision.test.ts` -> exit 1, 16/21 pass and 5 expected failures.
   - `npm test -- tests/pipeline.test.ts` -> exit 1, 10/13 pass and 3 expected failures (one fixture geometry plus two malformed outer bodies).
   - `npm test -- tests/package-scripts.test.ts` -> exit 1, 0/1 pass.
3. Focused GREEN: `node --import tsx --test tests/planner.test.ts tests/mask.test.ts tests/qwen-vision.test.ts tests/pipeline.test.ts tests/package-scripts.test.ts` -> 35/35 pass.
4. Source-only full suite: `npm test` -> 78/78 pass.
5. `npm run lint:types` -> exit 0.
6. `npm run build` -> exit 0.
7. Compiled validation: `npm run test:compiled` -> 78/78 pass.
8. `bash -n scripts/accept-slide-07.sh` -> exit 0.
9. `git diff --check` and `git diff --cached --check` -> exit 0.
10. Credential scan over added lines found only the two deliberately fake malformed-body canaries and their assertions; excluding those named canaries, no credential-shaped values matched.
11. Placeholder scan over `src`, `tests`, `README.md`, `scripts`, and non-plan docs found no unresolved implementation placeholders; the documented README `<your-api-key>` setup token is intentional.

### Round 2 self-review and concerns

- Self-review traced the normal/invalid outer/invalid inner provider paths, confirmed both provider promises still settle before failed staging moves, and found no bypass of output ownership, canonical-path validation, redirect rejection, or recording sanitization.
- `dist` is generated and ignored. It was rebuilt only for the explicit compiled validation and is not committed.
- No Alibaba credentials were available. The official-envelope behavior and failed-response evidence are verified offline with mocked transport, not by a live authenticated call.
