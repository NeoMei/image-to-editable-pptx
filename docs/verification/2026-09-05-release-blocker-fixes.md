# Release-blocker fixes

## Changes and regression evidence

This follows the historical findings in `2026-09-05-v0.3.0-release-gate.md`.
All changes remain on `codex/model-fallback`; no release is implied.

- **API and host response envelopes:** OCR and scene require `status: "completed"`
  with no error or incomplete details. Content filtering is terminal refusal.
  Failed, incomplete, filtered, and malformed cases are covered by injected
  complete response envelopes, not success-only stubs.
  Final review caught the equivalent host gap; both OpenAI SSE and Gemini
  non-streaming host parsing now apply the same clean-envelope requirement
  before output-item reconstruction. Ten host cases cover error/details
  rejection, null-field success, and refusal precedence (four failed before
  the fix and all ten passed afterward).
- **Explicit stream disconnect:** only the known
  `upstream_error / upstream_reset` pair joins existing retryable cases.
  Actual router tests reach Gemini after that error; unknown errors, malformed
  streams, truncation, and refusal still stop.
- **Host discovery:** measured a successful local endpoint command taking
  19,205 ms, while the previous bridge stopped at 15,035 ms before any HTTP
  request. The subprocess ceiling is now 45 seconds. A real controlled `ocx`
  subprocess returning after 16 seconds failed before the change and passes
  afterward. The POSIX executable regression is skipped on Windows.
- **Text backing:** recover enclosed glyph support before removing carried
  text, restore alpha only for repaired text, and reject ambiguous recovered
  colors. The real white-text fixture changed from 1,978 nonopaque glyph-region
  pixels to zero, with exact blue fill and no source mutation. Tests preserve
  rounded corners and an unrelated enclosed cutout, and reject unsafe
  contour-connected or differently colored inside-text-box cutouts.
- **Text layout:** inferred tracking now retains the existing width safety
  reserve. Office auto-wrap is disabled because the manifest already carries
  OCR line boundaries; explicit CRLF/newline paragraphs remain intact.
  Reducing tracking alone did not resolve WPS wrapping, which is why the
  exporter guard is also required. Font recognition was not added.

New regressions were observed failing before their corresponding fixes.
Independent backing re-review accepted the final conservative treatment of
the inside-OCR-box cutout. Same-color, visually indistinguishable marks cannot
be perfectly separated semantically from glyphs; noisy/multicolor cases may
be conservatively kept in the background.

## Fresh verification

- `npm run verify`: 489 source tests and 489 compiled tests passed, no skips
  on this Mac; typecheck, build, audit, and whitespace checks passed.
- Dependency audit retains the existing two unreachable `image-size`
  exceptions, review due 2026-10-03; dependencies are unchanged.
- `npm pack --dry-run --json`: 51 entries, package version 0.3.0.
- Final whole-branch review and focused host-envelope re-review found no
  remaining Critical, Important, or Minor findings; the merge code-review
  gate passed after the full verification above.
- Offline rebuild from the original live OpenAI analysis succeeds with six
  editable text objects and one repaired text-backing asset.
- All three final QA previews were inspected. Layer/exploded previews now
  show a plain blue backing, with no glyph-shaped holes.

## Real WPS acceptance

Exact tested artifact:
`.codex-tmp/release-v0.3.0/fixed-nowrap-output/slide-editable.pptx`.

WPS now displays `MODEL ROUTING` on one line and `HOST FIRST` without the
previous double appearance. Replaced the title with `WPS FIX CHECK`, confirmed
native editing, and undid it. Moved the backing independently: it carried no
residual text. Undid the move, closed, explicitly chose **Don't Save**, reopened
the same path, and verified original text and placement.

A rebuild after the additional backing safety check is preserved under
`.codex-tmp/release-v0.3.0/final-output/`. Its 18 `ppt/` content entries are
identical to the WPS-tested artifact after excluding generated image-description
attributes containing staging paths; media bytes, text, geometry, and style
match. This is a tested synthetic regression, not a claim of exact font recovery
or general PowerPoint/Windows acceptance.

PPTX SHA-256:

- WPS-tested: `fd40d0f18159e7a5292464e4a99ed7be7edf6895d4fb36536c9282a2c8292e1e`
- Final rebuild: `e5929c64082829cce25a7ed4fc843980d9080e3872c3edab6ca4f0b18c893cb6`

## Live routing and remaining release boundary

After the discovery change, live discovery succeeded in 8,500 ms and reported
both providers' OCR, scene, and completion capabilities. Capability advertisement
is not success evidence by itself.

A new synthetic circle/occluder CLI run selected `host-openai / gpt-5.6-sol`
for OCR, full scene, and regional scene, with three successful transports and
a real PPTX. The ledger still records zero completion requests and keeps the
occluded circle in the background, so naturally selected completion acceptance
remains open. No geometry or safety gates were loosened to force that call.

A Gemini-isolated run now actually reached `host-gemini` once, but OCR returned
`invalid_output` and stopped without publishing a partial package. This is
distinct from the previous zero-transport host-skipping defect.
A single direct synthetic probe reproduced it in 9,937 ms: HTTP 200, completed
outer envelope, but the 299-character extracted message failed JSON parsing
after standard code-fence normalization, before OCR geometry validation. Raw
output was not retained; this does not establish nondeterminism or distinguish
malformed JSON from prose/unsupported wrapping. No broader retry was introduced.

No merge, push, remote CI, tag, npm publication, or installed-cache update was
performed. Full release readiness still requires closing the natural-completion
acceptance boundary; no code-review findings remain.

Follow-up: `2026-09-05-natural-occlusion-mask-fix.md` records the repaired natural
selection and alpha-mask consumers, 493 source/compiled tests, and successful
live completion transport. Accepted generated-layer and WPS acceptance remain
open; the earlier zero-request snapshot above is historical.
