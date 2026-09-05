# Natural occlusion mask repair

## Scope and root cause

This continues the release-blocker investigation on `codex/model-fallback`
(base HEAD `cea316e`). It is not release or installation evidence.

The saved real scene analysis of `occlusion-source.png` identified a blue circle
behind an orange bar. Generic foreground extraction included 27,040 bar pixels
in the rear candidate's 91,157-pixel support. Hidden-evidence derivation treated
these as protected visible pixels and never requested completion. An offline
probe using that unchanged scene and OCR produced zero calls before subtraction
and one after subtraction; the repaired production path now produces one call
with the original contaminated mask.

Only graph-accepted occluders are subtracted, before opposing-contact evidence
is derived. Corrected support is passed to the provider and retained in the
completion artifact and provenance hash. No-overlap inputs retain their bytes.
Crop bounds, original visible RGBA, edit-region confinement, contact bridging,
contour continuity, and review-required checks remain enforced.

Two adjacent mask-consumer defects were exposed: offline completion validation
and mask projection discarded alpha, while API/host request padding interpreted
transparent white pixels as foreground. These consumers now use alpha support
when present and grayscale otherwise. No output-quality gate was relaxed.

## Regression and review evidence

- Observed RED then GREEN for contaminated-mask completion eligibility.
- One-sided support still cannot create opposing visible contacts.
- Observed RED then GREEN for an alpha-backed completion becoming a real
  semantic asset; recomposition and provenance are checked.
- Observed RED then GREEN for adapter padding: protected support was incorrectly
  `[255,255,255,255]`, now `[0,255,255,0]`; hidden-mask polarity and protected
  padding are also checked.
- Final `npm run verify`: 493 source and 493 compiled tests pass, no failures or
  skips on this Mac; typecheck, build, audit, and whitespace checks pass.
- The existing two unreachable `image-size` audit exceptions remain, due for
  review on 2026-10-03. No dependency change or audit downgrade.
- Package dry run: version 0.3.0, 51 entries.
- Independent scoped review accepted the final occlusion, adapter, and offline
  decoding changes without Critical, Important, or Minor findings.

## Live evidence and limits

Artifacts are under ignored `.codex-tmp/release-v0.3.0/`.

1. `natural-completion-final.failed-runs/`: real host OpenAI OCR and full scene
   succeeded; regional scene returned terminal `invalid_output`. The failed
   run retained its routing report and did not publish a partial analysis.
2. `natural-completion-no-regions/`: using the supported explicit regional budget
   of zero isolated the natural full-scene path. OCR and scene selected
   `host-openai / gpt-5.6-sol`; completion selected `host-openai / gpt-image-2`
   with one successful transport. This run started before the final adapter
   alpha fix. The ledger has one completion request but zero accepted completion
   artifacts; the circle remains in the background. All three QA previews were
   inspected and confirm only the front bar is extracted. This proves natural
   selection and transport, not accepted reconstruction.
3. `natural-completion-alpha-fixed/`: fresh CLI after all mask fixes, again
   with regional analysis explicitly disabled. All three host OpenAI operations
   succeeded, including one `gpt-image-2` completion transport. It still yielded
   zero accepted completion artifacts. The real final run therefore closes the
   zero-call defect but not generated-layer acceptance. The ledger only records
   `occlusion_completion_unavailable`, so the exact rejection sub-check is not
   established by this evidence. No retry policy was changed to hide it.

Final real-run PPTX SHA-256:
`a3edb88e10a67f0ffbd3e20815f537bc54ddd14919f6df8196fc42ec01e6ea6d`.

No model output, scene geometry, or protected pixels were edited to force a
passing acceptance. A successful transport is not a successful completion layer.
Real WPS acceptance of a generated hidden-region layer remains open; previous
text/backing WPS acceptance does not cover this case. No merge, push, remote CI,
tag, npm publication, or installed-cache update has been performed.

## Follow-up: exact rejection diagnosis

A single isolated completion probe reused the unmodified scene/OCR from
`natural-completion-alpha-fixed/`, rebuilt the same candidate masks, and used
the production discovery, routing, adapter, and completion gate. This is a
stage-level diagnostic, not another full CLI acceptance run.

Private ignored evidence directory:
`.codex-tmp/release-v0.3.0/completion-diagnostic-5hospK/`.
It contains source crop, hidden/protected masks, normalized provider return,
pixel counts, and sanitized routing outcome. No credentials are retained.

- `host-openai / gpt-image-2` returned successfully; original and returned crops
  both measure 363 by 361 pixels.
- 130,766 pixels changed; 63,857 of 64,117 protected visible pixels changed.
- 101,901 changed pixels lie outside the allowed hidden mask; 28,865 inside it.
- The original and returned crops were visually inspected: the returned image
  retains the orange front bar and adds texture/color variation instead of
  reconstructing the missing blue rear circle.
- `completeOccludedCandidate` correctly rejects the result at its protected
  visible-pixel / outside-hidden-mask guards, before contour acceptance. This
  rejection is not an endpoint connection failure or a geometry mismatch.

The existing host endpoint receives masks as labeled reference images, not an
enforced pixel-write boundary. Current semantic context supplies only candidate
kind and relation count. The observed result demonstrates that successful
transport and an instruction to preserve pixels are insufficient.

No production behavior was changed during this diagnosis. A proposed follow-up
requires explicit design approval: supply an unambiguous rear-object completion
request with the occluder removed from editable input, composite only validated
hidden pixels locally onto immutable source pixels, and reject residual occluder
appearance, bad seams, and broken contours. Merely discarding provider changes
outside the mask would not repair this sample because the bar remains inside it.
