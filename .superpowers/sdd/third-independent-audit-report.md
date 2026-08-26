# Third Independent Comprehensive Audit Report

Date: 2026-08-26

Branch: `feature/enhanced-prototype`

Starting HEAD: `cd1b766dc067a59d643df1f74f9e7eed0b5f811f`

Implementation fix: `a413c2c` (`fix: reconcile fidelity publication ledger`)

## Verdict

The eight fidelity-first implementation tasks remain complete. This third independent audit did not reuse the prior completion verdict as proof: it rebuilt the dependency graph, reran the source and compiled systems, traced the publication and provider paths again, generated a new Slide 7 artifact, reconciled its bytes and OOXML, and repeated real WPS interaction.

The audit confirmed one new root-cause defect with two independently reproduced consequences: the pipeline trusted a fidelity builder's manifest, decision ledger, and in-memory asset map without reconciling them. It could therefore publish an orphan asset that had no ledger hash, or publish a manifest whose accepted candidate had no decision. Both cases were captured as failing tests before implementation, fixed before any output write or PPTX export, and repeated through source and compiled gates.

No unresolved Critical, Important, or worthwhile Minor implementation defect remains in the reviewed CLI/backend, provider/parser, recording, image/fidelity, publication, PPTX export, or WPS-facing path. The disclosed residual is the upstream `pptxgenjs -> image-size` advisory described below.

## Original requirement reconciliation

| Requirement | Fresh third-audit evidence | Result |
|---|---|---|
| Preserve fidelity and prioritize editable text | Full-size source/render comparison; ten text objects; panels, bars, borders, texture remain background | Pass |
| Exactly ten editable Slide 7 OCR texts | Manifest 10, OOXML 10 named text shapes, text-span 10/10, WPS title and slogan edits | Pass |
| Split only safe major icons | Four transparent assets accepted, one icon candidate kept in background, no rectangular asset published | Pass |
| Do not rebuild structural furniture as native shapes | Manifest has zero structural shapes; only background + text + transparent assets | Pass |
| Failed or inconsistent builds do not publish | Two new malformed fidelity-result regressions reject before publication; atomic publication suite passes | Pass |
| Build from recorded analysis without credentials or local models | Fresh `build` completed with credential variables unset and empty task IDs | Pass |
| Ledger, manifest, assets, and output bytes agree | 14 accepted IDs equal 14 manifest IDs; all checked SHA-256 values match; no orphan assets | Pass |
| Output visibly renders without overflow | Bundled renderer plus `slides_test.py`: zero overflow; full-size inspection clean | Pass |
| Objects are genuinely editable in WPS | Exact copy: title/slogan replacement and eye/radar move, undo, explicit no-save, hash check, reopen | Pass |

## Review pass 1: state, provenance, ledger, and publication

### Confirmed root cause

`buildFromAnalysis` parsed the manifest but then wrote every entry in `fidelityResult.assets` and copied every decision into `run-ledger.json` without proving that the three representations described the same accepted elements. The output contract promised a complete per-candidate ledger and hashes for every published asset, but the pipeline enforced neither relationship.

### RED evidence

1. `rejects an untracked fidelity asset before publication` injected `assets/orphan.png` without a manifest element. The old code completed successfully, published the orphan file, and omitted it from `hashes.assets`.
2. `rejects a fidelity decision ledger that does not cover the manifest` removed the first OCR decision while leaving its manifest text element. The old code again completed and published a self-contradictory ledger.

### Minimal root-cause fix

`validateFidelityResult` now runs after manifest parsing and the page-specific accepted-text count, but before any asset, manifest, mask, background, PPTX, ledger, or ownership marker write. It verifies:

- unique planned candidate, manifest element, and decision IDs;
- exactly one decision for every planned candidate and no unexpected decision;
- candidate and decision kinds agree;
- every required text is accepted as a text layer;
- every accepted icon resolves to a transparent asset layer;
- decision output state, manifest element ID, and asset path agree;
- every manifest element is covered exactly once;
- manifest asset paths and the in-memory asset map are exact set equals.

### GREEN evidence

- Both focused regressions pass and leave the fixed target unpublished.
- State/publication/contracts set: 32/32 pass.
- Full source and compiled suites: 160/160 each pass.

The pass also rechecked target canonicalization, ownership markers, failed-run handling, backup rollback, stale-output replacement, source provenance, analysis-ledger preservation, required-text gates, and private recording writes. No additional reproducible defect was confirmed.

## Review pass 2: provider, recording, image, fidelity, and export boundaries

The audit independently traced credential loading, fixed regional endpoints, redirect refusal, response observation and redaction, schema parsing, provider geometry clipping, local mask generation, outside-mask invariance, transparent extraction, text overlap, recomposition, style inference, deterministic z-order, and PPTX export.

Focused pass: 81/81 tests passed. The post-fix all-source gate and compiled gate each passed 160/160. No further production change was justified by a reproducible failing behavior.

## Review pass 3: new artifact, OOXML, visual render, and WPS

### Fresh build

- Source: `/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png`
- Recorded analysis: `output/slide-07`
- Output: `output/slide-07-third-independent-audit`
- Network credentials: explicitly unset for the build
- Deliverable SHA-256: `5c869e7c6d58da8518958bcf571802151a2907cd4acdcb42ffa81d68f4060fd2`

### Structural and byte reconciliation

- Manifest: 14 elements = 10 text + 4 transparent assets + 0 shapes; zero warnings.
- Ledger: 15 decisions = 14 accepted + 1 kept in background; empty task IDs; zero warnings.
- Accepted manifest IDs: exact equality with manifest element IDs.
- Hashes: source, OCR, Vision, analysis ledger, manifest, removal mask, clean background, four assets, and PPTX all match actual bytes.
- OOXML: five pictures (one background plus four named assets) and ten named text shapes.
- Layer names: `asset-background`, four `asset-icon-*`, and `text-ocr-1` through `text-ocr-10`.

### Render and text checks

- The bundled renderer emitted 1600x900; the untouched render was retained and a proportional 1280x720 QA copy was used for the source-pixel acceptance algorithm.
- `slides_test.py`: pass, no overflow.
- Source-backed text span/anchor: 10/10 pass.
- Full-resolution visual inspection: no clipping, unintended wrapping, rectangular asset background, repair seam, pseudo-text, or material composition drift.

### WPS exact-file acceptance

The fresh PPTX was copied to `.codex-tmp/third-independent-audit-wps-smoke/slide-07-editable-smoke.pptx`; the copy and deliverable hashes matched before opening.

1. Finder selected the exact absolute path and WPS window title was confirmed as `slide-07-editable-smoke.pptx`.
2. The main title was replaced with `TITLE EDIT`.
3. The bottom slogan was replaced with `SLOGAN EDIT`.
4. The accepted eye/radar asset was selected as one picture layer and moved, exposing the repaired background beneath it.
5. Three undo operations restored the title, slogan, and asset position.
6. WPS displayed the save-changes prompt; `不保存` was explicitly selected.
7. Deliverable and smoke-copy SHA-256 remained `5c869e7c6d58da8518958bcf571802151a2907cd4acdcb42ffa81d68f4060fd2`.
8. The same exact file was reopened; its title, slogan, icon position, and window title were visibly restored, then it closed without a save prompt.

## Final repeated clean-install gate

- `npm ci`: pass from the lockfile.
- Source tests: 160/160 pass.
- Typecheck: pass.
- Build: pass.
- Compiled tests: 160/160 pass.
- Experimental coverage run: 160/160 pass; 96.61% line, 85.75% branch, 98.45% function coverage.
- `git diff --check`: pass.
- Credential-pattern scan outside synthetic tests and lockfile: clean.
- Fresh artifact tests: hash/manifest/OOXML, no-overflow, text-span, full-size visual, and WPS all pass.

## Dependency residual

`npm audit` reports two High advisories through `pptxgenjs@4.0.1 -> image-size@1.2.1`: an ICNS infinite-loop parser issue and JXL/HEIF infinite-loop parser issues. The audit range includes every available `image-size` release through 2.0.2; npm's offered forced action is a downgrade to `pptxgenjs@1.1.5`, not a patched upgrade.

The exercised exporter path supplies only source-validated PNG and locally generated PNG background/assets with explicit dimensions. ICNS, JXL, and HEIF are not accepted by this application path. The residual is therefore disclosed as an upstream, currently non-reachable advisory; a breaking downgrade that remains in the vulnerable range would not be a valid fix.
