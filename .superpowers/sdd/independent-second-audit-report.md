# Independent Second Comprehensive Audit Report

Date: 2026-08-26

Branch: `feature/enhanced-prototype`

Starting HEAD: `807db3249142fc5f3104728987944073fba4e62b`

## Verdict

The eight fidelity-first implementation tasks remain complete. A fresh, independent three-pass audit found four additional actionable defects. Each was reproduced with a failing regression test, repaired at the root cause, and rechecked with focused, full source, compiled, artifact, render, and WPS gates.

No unresolved Critical, Important, or worthwhile Minor implementation defect remains in the reviewed CLI/backend, provider/parser, image/fidelity, publication, PPTX export, or WPS-facing paths. The only disclosed residual is the already-known upstream `pptxgenjs -> image-size` advisory with no patched published `image-size` release.

## Requirement reconciliation

| Requirement | Fresh evidence | Result |
|---|---|---|
| Source is exactly a 1280x720 PNG | New non-PNG regression; Sharp metadata format and dimension validation | Pass |
| Analysis and build use the same source bytes | New integrated-run replacement regression; build-time source hash recheck | Pass |
| Exactly 10 required editable text layers | Manifest, OOXML names, text-span 10/10, WPS title and slogan edits | Pass |
| Only safe transparent icons are editable | 4 transparent assets accepted, 1 candidate kept in background, WPS eye/radar move | Pass |
| Panels, bars, borders, texture, and uncertain graphics stay in background | Manifest has 0 shapes; full-resolution render and exposed-background WPS check | Pass |
| Failed-run retention cannot be redirected after preflight | New post-preflight symlink race regression; point-of-use `lstat` | Pass |
| Build remains credential-free and local | Rebuild completed under `env -i`; ledger `taskIds` is empty | Pass |
| Ledger and output bytes reconcile | 14 accepted IDs equal 14 manifest IDs; all checked hashes and asset keys match | Pass |
| Evidence is private and credential-free | JSON modes are `0600`; generated-output secret scan is empty | Pass |
| PPTX opens and edits in the target client | WPS edit/move/undo/explicit-no-save; smoke and deliverable hashes unchanged | Pass |

## Review pass 1: CLI, state transitions, and publication

Confirmed defect: a `<target>.failed-runs` directory could be replaced with a symlink after publication preflight but before failure retention. The old recursive `mkdir` followed that symlink and moved staged evidence into the external directory.

- RED: `does not follow a failed-run symlink introduced after publication preflight` moved a hidden staging directory into the external target.
- Fix: create the failure root without recursive traversal, tolerate only `EEXIST`, then revalidate with `lstat` at the point of use and refuse links/non-directories.
- GREEN: focused regression, complete pipeline/publication suite, source suite, and compiled suite all pass; the original operation error remains visible and the external directory stays empty.

Confirmed defect: if failed-run retention itself encountered an I/O or permission error, that secondary error replaced the primary build failure and hid the actionable diagnosis.

- RED: `does not mask the primary build error when failed-run retention is unavailable` surfaced `EACCES` instead of the simulated build failure.
- Fix: failed-run root creation and point-of-use inspection are best-effort; an unavailable retention destination leaves staging in place and never replaces the primary operation error.
- GREEN: focused regression and the complete pipeline/publication suite pass with the primary error preserved.

The pass also rechecked CLI option ambiguity, configuration preflight, canonical target boundaries, ownership marker handling, atomic backup/rollback, stale asset removal, failed-run separation, private recording writes, and secret redaction. No further actionable defect was confirmed.

## Review pass 2: input, provenance, provider, and fidelity boundaries

Confirmed defect 1: `inspectSourceImage` enforced only dimensions, so a 1280x720 JPEG renamed to `.png` was accepted despite the documented PNG-only contract.

- RED: `rejects a non-PNG source even when it has the required dimensions and extension` completed analysis instead of rejecting the JPEG bytes.
- Fix: require Sharp metadata format `png` before accepting the source.
- GREEN: focused and complete pipeline tests pass; invalid input is rejected before an analysis directory is created.

Confirmed defect 2: integrated `run` read the source once for analysis and again for build without comparing the second read to the analysis ledger. Replacing the source between phases could combine OCR/Vision from image A with pixels from image B.

- RED: `rejects a source image replaced between integrated analysis and build` published successfully with mismatched source provenance.
- Fix: `buildFromAnalysis` now hashes the exact bytes it consumes and compares them to `analysis-ledger.json` before creating build artifacts.
- GREEN: focused regression and all pipeline/publication tests pass; the mismatched run fails before publication.

The pass additionally rechecked endpoint pinning, redirects, timeouts, result URL allowlists, bounded response recording, schema and geometry validation, mask and alpha boundaries, outside-mask invariants, transparent extraction, recomposition, text style inference, and z-order. No further actionable defect was confirmed.

## Review pass 3: clean rebuild, OOXML, rendering, and WPS UI

- Rebuilt `output/slide-07-independent-second-audit` from the unchanged source and recorded live analysis with no credential environment and no network/image-edit authorization.
- Manifest: 10 text + 4 transparent assets + 0 shapes; 15 decisions = 14 accepted + 1 kept in background; 0 warnings.
- Ledger: empty task IDs; accepted decision IDs exactly equal manifest IDs; asset key set and checked SHA-256 values match generated bytes.
- OOXML: one background image, four named asset pictures, ten named text objects.
- Bundled presentation test: pass, no overflow.
- Full-resolution visual review: no clipping, wrapping, seams, or material displacement.
- Source-backed text span/anchor: 10/10 pass.
- WPS: edited main title and bottom slogan, moved the eye/radar asset, observed a clean exposed background, undid all operations, closed with explicit `不保存`, and preserved both hashes.

## Final clean-install gate

- `npm ci`: pass
- Source tests: 158/158 pass
- Typecheck: pass
- Build: pass
- Compiled tests: 158/158 pass
- Experimental coverage run: 158/158 pass; 97.39% line, 86.71% branch, 98.43% function coverage
- `git diff --check`: pass
- Generated-output credential scan: pass
- Deliverable SHA-256: `f17cbaa29e8f19cc87dc204c5db0994dd48aa3039dc7205ecd275ae52aaa7a3d`

## Dependency residual

`npm audit` still reports two High entries for `pptxgenjs@4.0.1 -> image-size@1.2.1`: the ICNS parser advisory and the JXL/HEIF parser advisory. The npm registry currently reports `image-size@2.0.2` as latest, while both advisory ranges include every release through 2.0.2. npm's proposed forced change is a downgrade to `pptxgenjs@1.1.5`, whose dependency remains in the vulnerable range, so it is not a valid remediation.

This exporter supplies only source-validated PNGs and locally generated PNG background/assets with explicit dimensions. It does not send ICNS, JXL, or HEIF inputs through the dependency. The residual therefore remains disclosed as an upstream, non-reachable risk rather than forcing a breaking non-fix.
