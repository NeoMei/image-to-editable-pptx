# Fidelity Final Review Fix Report

Date: 2026-08-26

Scope: all three Important findings and the requested low-cost Minor findings from `fidelity-final-review-report.md`

Network policy: zero live API calls and zero intentional network calls; all artifact rebuilds used the unchanged Task 8 recordings.

## Outcome

PASS. The publication path now enforces the optional exact text-count contract before any export or promotion, provider raw recordings receive bounded recursive value-level sanitization, and deterministic tracking is inferred and exported for editable text. The Slide 7 acceptance entrypoint requires exactly 10 texts. Offline `build` no longer loads live credentials. All requested threshold, clipping, and repair regressions are present, and the two stale reports are corrected.

The final offline artifact contains exactly 10 editable text layers, 4 transparent asset layers, 0 native structural shapes, 1 background, 15 ledger decisions, 14 accepted decisions, 1 kept-in-background icon, 0 warnings, and no task IDs. Automated WPS-render text evidence passes 10/10 with zero OOXML overflow. A real WPS edit/move/undo/no-save smoke passed on a byte-identical copy.

## TDD and debugging evidence

All RED runs were deliberate new regressions against the pre-fix behavior; implementation followed only after the failures were understood.

### Important 1: exact text-count publication gate

- RED command: `node --import tsx --test tests/accept-script.test.ts tests/cli.test.ts tests/pipeline.test.ts`
- RED result: 6 expected failures covering the missing CLI/acceptance contract, offline-build dispatch, and prepublication count behavior.
- Intermediate GREEN exposed one test-fixture ID mistake: 20/21 passed; the fixture was corrected without weakening the assertion.
- GREEN behavior: acceptance command contains the exact whole line `--required-text-count 10`; generic build/run remain count-agnostic; invalid counts are rejected.
- Production-path regression first publishes an owned 10-text success, then replays a normalized 9-text analysis with `requiredTextCount: 10`. It proves the fidelity builder is not called, the previous success tree is byte-identical, OCR/Vision/analysis evidence is retained under `.failed-runs`, and neither manifest nor PPTX is partially promoted.
- A second regression removes one accepted text after fidelity build and proves failure occurs before PPTX export and ownership-marker creation.

### Important 2: provider response sanitization

- Initial RED: focused recording/pipeline tests failed because `sanitizeProviderRecording` did not exist and nested values under innocuous keys survived the ordinary valid-JSON raw-response path.
- GREEN command: `node --import tsx --test tests/recording.test.ts`; result 5/5 passed.
- Additional RED/GREEN canaries independently exposed and then closed Alibaba `X-Acs-*` and OSS `X-OSS-*` header-assignment cases; each RED was 4/5 and each final GREEN was 5/5.
- Coverage includes nested objects/arrays, the exact configured API key (including in a property name), Bearer values, credential-shaped values, DashScope/Alibaba/OSS header keys and assignments, signed object-storage URLs, huge values/property names, excessive aggregate string volume, excessive node counts, and excessive depth.
- A final staged-diff self-review added a separate RED/GREEN for the aggregate and property-name bounds: the missing total-string export was RED, then the focused recording suite returned to 5/5 GREEN.
- The stored envelope includes only the sanitized payload plus deterministic truncation counts/flags. Limits are 8,192 characters per value, 256 characters per property name, 65,536 aggregate recorded string characters, 4,096 visited nodes, and depth 16. Signed URLs are replaced in full.
- `responseObserver.recordRawResponse` now sanitizes with the configured key before `writeRecording`; the existing invalid-body sanitizer remains unchanged.

### Important 3: typography tracking fidelity

- RED: 4 focused style/contract/export assertions failed because tracking was absent.
- First GREEN: 28/28 focused typography/export/contract checks passed.
- Full-size WPS rendering then exposed tracked headings wrapping inside their original boxes. New generic display-tracking and exported-box-slack regressions failed 3 checks before implementation and passed 29/29 after the fix.
- A final acceptance-tool RED (`ERR_MODULE_NOT_FOUND`) proved the 10-text source/render comparison was not yet reusable; `node --import tsx --test tests/text-span.test.ts` is now GREEN at 2/2 and explicitly covers all ten manifest text rows plus rejection beyond tolerance.
- Tracking uses source glyph-bound span, chosen font size, named script-aware advance units, and visible gap count. Multiline text selects one deterministic conservative minimum feasible value. Generic named limits are 0–36 px; display handling is based only on font size, with no slide ID, slide string, or Slide-7 constant.
- Manifest v1 accepts optional `charSpacingPx` for backward compatibility. Export converts px to points for PptxGenJS `charSpacing`; tracked boxes receive at most 16 px safe right-side slack clipped to the canvas.
- Unit coverage includes zero/positive CJK, Latin, mixed, whitespace, single-character, extreme bounded, display, and multiline cases.

### Minor findings

- `build` is dispatched without `loadConfig`; a missing-environment CLI regression passes.
- Inclusive candidate gates are tested at confidence 0.80, width 24, height 24, and area 1600, including post-clipping eligibility.
- Asset-mask canvas-edge clipping is directly tested.
- The outside-mask local-repair test now requires `accepted === true`; a direct `filledPixelDistanceP95 > 28` rejection test passes.
- Task 2's report header includes fix commit `a93849d`; Task 3 describes OCR/foreground-bound dilation.

## Files changed

Production and tooling:

- `src/cli.ts`, `src/contracts.ts`, `src/pipeline.ts`
- `src/recording.ts`
- `src/fidelity/text-style.ts`, `src/export/pptx.ts`
- `src/acceptance/text-span.ts`, `scripts/measure-text-span.ts`
- `scripts/accept-slide-07.sh`, `package.json`, `tsconfig.json`, `README.md`

Tests:

- `tests/accept-script.test.ts`, `tests/cli.test.ts`, `tests/contracts.test.ts`
- `tests/pipeline.test.ts`, `tests/recording.test.ts`
- `tests/text-style.test.ts`, `tests/pptx.test.ts`, `tests/text-span.test.ts`
- `tests/fidelity-candidates.test.ts`, `tests/asset-mask.test.ts`, `tests/local-repair.test.ts`

Evidence corrections:

- `.superpowers/sdd/task-2-report.md`
- `.superpowers/sdd/task-3-report.md`
- `.superpowers/sdd/fidelity-final-fix-report.md`

## Final automated verification

- Focused affected suite:
  - command: `node --import tsx --test tests/accept-script.test.ts tests/cli.test.ts tests/pipeline.test.ts tests/recording.test.ts tests/contracts.test.ts tests/pptx.test.ts tests/text-style.test.ts tests/text-span.test.ts tests/fidelity-candidates.test.ts tests/asset-mask.test.ts tests/local-repair.test.ts`
  - result: 67 passed, 0 failed.
- Source suite: `npm test` → 147 passed, 0 failed.
- Typecheck: `npm run lint:types` → exit 0.
- Build: `npm run build` → exit 0.
- Compiled suite: `npm run test:compiled` → 147 passed, 0 failed.
- Patch hygiene: `git diff --check` → exit 0.
- Artifact/production literal scan → 0 matching files; synthetic test canaries are intentionally confined to 3 test files.

No test used external network access. Provider tests replace `globalThis.fetch` with local deterministic stubs. No live credentials were loaded for offline build.

## Offline rebuild and integrity reconciliation

Offline command (credentials deliberately absent):

```bash
env -i PATH=/usr/local/bin:/usr/bin:/bin npm run cli -- build \
  --image '/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png' \
  --analysis output/slide-07 \
  --out output/slide-07-final-fix \
  --required-text-count 10
```

Result: exit 0. The unchanged inputs reconcile as:

- source image: `a289f2d6e3156b21d8e2c01835e9ec63e490827fc8f338215778e544b57e7f11`
- OCR recording/output: `69247583fe43de6af04fb62e4820fbe49bf0eae38584494e75b3d8b97f36827a`
- Vision recording/output: `e5202381abbe96ccee63dbb90bab73549c406ff24a96ae87a33152b3ae963655`

Final ledger reconciliation passed 14/14 byte hashes:

- analysis ledger: `b614e13f979b90e7a053e660c06d4f116e7db8b630fe5f1047d5f0cc7ee416c5`
- manifest: `24425cb5aad2821df8c29300d9d9e296372a2a995478b7b4dd117e5690c58817`
- removal mask: `4ddf9f65b64d76d51ce3a2a49b2318bdd66c58228cadf94e36a581c6f7c6400b`
- clean background: `2b02b2464f95365be52ceaf9c154d2756a340e4a4b10bce2e8b52b3931b0c1f2`
- asset `icon-5`: `4e9327927128b5253bab1a22edf1939bdf26932ff7622333aedbdeb0c385b168`
- asset `icon-10`: `03626ad3e34becccb96245f04ec9287f9ef1c1ef02fb5716814806c065c06f10`
- asset `icon-12`: `18a0aa4afbe1f0c589e6cbd7e8bb49e4f67482625bf33b0c9cafb0629f06e745`
- asset `icon-14`: `f7067990dba3a6abba6c940fe68d09016171ca01ecf652c2f87554229de3e33e`
- PPTX: `131ceaa5db2acd5263738c881165e3313a1fcd1ad74288f7c0e18931c4df3209`

Manifest counts are 10 text / 4 asset / 0 shape. Ledger decisions are 10 accepted text / 4 accepted icon / 1 kept icon, warnings `[]`, and `taskIds: {}`. The final run ledger lists only OCR and Vision models. This, the offline command's empty environment, and the absence of any default-pipeline Wanx call are the no-live/no-Wanx evidence.

## Render, typography, and WPS evidence

Full-size images inspected:

- source: `/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png`
- clean background: `output/slide-07-final-fix/clean-background.png`
- final WPS render: `.codex-tmp/fidelity-final-fix/wps-final-slide.png`

Visual verdict: PASS. The source, clean background, and recomposed final slide show no residual/duplicated text, pseudo-text, repair seams, rectangular icon backings, or damaged panel/bar/border furniture. The kept shield artwork remains intentionally in the background. The four accepted transparent icons recompose cleanly.

Reusable measurement command:

```bash
npm run measure:text-span -- \
  --source '/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png' \
  --render .codex-tmp/fidelity-final-fix/wps-final-slide.png \
  --manifest output/slide-07-final-fix/manifest.json \
  --out .codex-tmp/fidelity-final-fix/text-span-evidence.json
```

Result: 10/10 PASS at named tolerances of 48 px horizontal span and 12 px left anchor. Per-text `(span delta, anchor delta)` in pixels: `ocr-1 (-6,-2)`, `ocr-2 (-22,-3)`, `ocr-3 (-15,-5)`, `ocr-4 (-1,-2)`, `ocr-5 (+1,-3)`, `ocr-6 (-1,-5)`, `ocr-7 (+7,-5)`, `ocr-8 (-1,-3)`, `ocr-9 (+3,-3)`, `ocr-10 (-4,-4)`. Evidence hash: `5a58117587fd795c94414cdb49af220d35d6f6c3482f3de49b5407cb1590ae15`.

OOXML overflow evidence at `.codex-tmp/fidelity-final-fix/overflow-evidence.json` passes: 15 objects, 10 text objects, 4 assets, 1 background, 9 character-spacing runs (the tenth intentionally has zero tracking), and 0 overflow.

Actual target-client smoke used WPS Office macOS `12.1.26055` (`com.kingsoft.wpsoffice.mac`) on `.codex-tmp/fidelity-final-fix/wps-smoke/slide-07-editable-smoke.pptx`. The copy hash before opening exactly matched the deliverable PPTX. In WPS:

1. The title and slogan were edited to distinct smoke strings.
2. The accepted eye/radar icon was selected and moved four right-arrow steps, approximately 27 source pixels; the exposed background was clean.
3. All changes were undone and the original visual state returned.
4. The file was closed using the explicit `不保存` action.

After closing, both the smoke copy and deliverable remained byte-identical at `131ceaa5db2acd5263738c881165e3313a1fcd1ad74288f7c0e18931c4df3209`. WPS-render image hash: `0c49a85efa1d9b91895f34333e251b667b72b946db7fdb7770cf09cb8f5310b3`.

## Secret and network hygiene

- No live API/network request was made in this fix wave.
- The offline rebuild ran under `env -i` with only `PATH`; `build` did not read credentials.
- Raw-response regressions use synthetic canaries only and assert no configured-key, Bearer, credential-shape, signed-query/fragment, or provider-header canary survives valid JSON serialization.
- Final artifacts and production literals were scanned for credential shapes, authorization values, provider secret headers, and signed query keys: 0 matching files.
- No secret values or signed URLs are included in this report.

## Self-review and concerns

The final diff was reviewed across command parsing, staging/promotion order, sanitizer recursion/bounds, manifest compatibility, PptxGenJS units, text measurement, and exact edge gates. The count checks occur before asset writes, PPTX export, ownership marker creation, and atomic promotion. No slide-specific ID/string branch was introduced.

One environment limitation remains: the provisioned bundled presentation helper could not run because its Python environment lacks `pdf2image`. LibreOffice rendering on this host also lacks reliable CJK font substitution. Neither was used to claim typography success; the stronger evidence is the actual WPS full-size render, reusable 10/10 measurement, OOXML zero-overflow check, and real WPS editability/no-save smoke. Typography remains subject to target-client font substitution, which is why the acceptance tool measures the target-client render rather than assuming OOXML metrics alone.
