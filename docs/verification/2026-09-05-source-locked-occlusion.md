# Source-locked occlusion verification

## Task 2: offline appearance calibration

This checkpoint covers only the source-local appearance helper. It does not
integrate the helper into the completion gate, call a provider, validate a live
response, publish an artifact, or establish release readiness. The task brief
supplied initial threshold candidates. Offline examples were labeled before
running the helper, and those examples were compared before the candidate values
were frozen. No threshold search used a live response.

The base fixture is a 32-by-24 cream canvas containing a low-variation blue rear
rectangle behind a separable orange front bar. Its opposing contact endpoints
are supplied explicitly. The positive return continues four hidden columns
through 16 rear rows (64 generated pixels) and returns identifiable background
above and below the rear object. Negative fixture labels cover an unchanged
front occluder, a shaded front occluder, background-only fill, a separable wrong
color, shifted rear support, an unclassifiable one-pixel seam, a glowing alpha
fringe, and an extra disconnected rear-colored island. Additional cases cover
one-sided/no evidence, same-color layers, excessive rear variation, gradients,
alternate palettes, a two-times raster scale, and diagonal source alpha fringes.

### Independent labeled comparison

These examples are separate from the one-level boundary tests. Their values are
not placed at the proposed cutoff. The positive and negative completion returns
use the same source, geometry, masks, contacts, and background pixels, so the
comparison exercises returned hidden content rather than a provider stub or a
different shape.

| Pre-labeled example | Measured fixture property | Observed helper result |
| --- | --- | --- |
| mildly varied source rear | source rear p95 deviation 4 | qualified |
| rough source rear beyond flat-color scope | source rear p95 deviation 14 | rejected `ambiguous_appearance` |
| base separable source | minimum palette separation 190 | qualified |
| rear/front palettes too close to distinguish | minimum palette separation 28 | rejected `ambiguous_appearance` |
| enough local context | 10 identifiable opaque background samples | qualified |
| sparse local context | 6 identifiable opaque background samples | rejected `insufficient_evidence` |
| subtly varied rear continuation | interior candidate distance up to 4 and alpha 246 | accepted with 64 generated pixels |
| near-rear impostor with identical geometry | interior candidate distance 17; source-colored contact edge retained | rejected `ambiguous_appearance` |
| semi-opaque glowing contact edge | candidate alpha 218 | rejected `ambiguous_appearance` |
| bounded continuation seam | source-to-returned seam delta 8 | accepted |
| visible bad continuation seam | source-to-returned seam delta 14 | rejected `seam_mismatch` |

All initial candidates from the task brief separated this pre-labeled set; none
failed it. Counterfactual candidates also show that separation was meaningful:
a sample minimum of 6 admits the sparse case while 11 rejects the enough-context
case; source p95 3 rejects the mild case while 14 admits the rough case; palette
separation 28 admits the close-palette case while 191 rejects the base source;
candidate distance 3 rejects the varied positive while 17 admits the impostor;
interior alpha 218 admits the glow while 247 rejects the positive; and seam delta
7 rejects the bounded seam while 14 admits the visible bad seam. These are
offline fixture observations, not claims about product-wide distributions.

### Frozen boundaries

The following one-level checks verify inclusive/exclusive implementation
semantics. They did not select the thresholds by themselves.

| Quantity | Units | Boundary check | Frozen value |
| --- | --- | --- | --- |
| Samples per source appearance class | unique opaque pixels | 8 qualified; 7 failed | minimum 8 |
| Source variation | p95 maximum RGB-channel distance from per-channel median | 6 qualified; 7 failed | maximum 6 levels |
| Source palette separation | maximum RGB-channel distance between class medians | 36 qualified; 35 failed | minimum 36 levels |
| Candidate palette distance | maximum RGB-channel distance from a source class median | 12 accepted; 13 failed | maximum 12 levels |
| Candidate interior alpha | 8-bit alpha | 240 accepted; 239 failed | minimum 240 |
| Source contact interior alpha | 8-bit alpha | 240 accepted; 239 failed | minimum 240 |
| Contact seam delta | maximum RGB-channel distance for adjacent source-visible/generated pixels | 12 accepted; 13 failed | maximum 12 levels |
| Mask support | 8-bit mask/alpha | inherited, not recalibrated here | minimum 16 |

Opaque candidate pixels classified as background are excluded from generated
support. Transparent returned pixels do not create support. Front-classified
pixels fail as `residual_occluder`; unknown opaque pixels and unreliable alpha
fringes fail as `ambiguous_appearance`. Missing contact continuation and
disconnected rear-colored islands fail as `contour_mismatch`. Returned changes
outside the hidden mask and on visible support are counted only as diagnostics;
the helper does not copy or composite any returned pixels. Overlapping visible
and hidden support is malformed geometry and is rejected before classification.

This calibration is deliberately finite: flat, low-variation, locally separable
colors at the tested raster scales. It is not evidence for textures, gradients,
glows, transparent boundaries, or semantically complex objects. In particular,
a uniform-color fake geometry can satisfy color checks without being the correct
hidden object. Existing contact/contour gates, final recomposition invariants,
and human review remain required. The rejected live orange-bar response was not
used to choose or adjust any threshold.

## Task 4: bounded diagnostics and offline boundary

Live routed and legacy analysis now record the detailed local completion outcome
in a separate version-1 `completion-diagnostics.json` sidecar before the strict
v2 analysis ledger is published. The sidecar permits only the canonical semantic
plan index, accepted/skipped/rejected status, bounded reason codes, and finite
bounded metrics. Existing v2 ledger fields, artifact hashes, and source
provenance remain unchanged. No additional raw request image or provider-return
image is added to public package content.

The routed integration checks distinguish three boundaries. A provider image can
be a successful `host-openai` transport while local quality rejects it as
`residual_occluder`; the run records one completion request, no completion
artifact, retains the source background, and does not call or advance to Gemini.
A terminal completion `policy_refused` still aborts the analysis and leaves no
quality sidecar. Separately, an actual locally evaluated source-locked completion
survives analysis staging, atomic package publication, package read, and an
offline build with zero network calls, producing a composite layer that remains
`reviewRequired: true`.

Sidecar publication uses exclusive private creation rather than the general
recording helper's replace-capable rename. Tests cover existing regular targets,
symbolic-link targets, concurrent replacement races, and a staged write failure
while an earlier owned output remains byte-identical and the foreign symlink
target remains unchanged. A v2 package without the optional sidecar still reads;
the offline build neither requires nor consults it for acceptance, and corrupt
sidecar content cannot rescue an invalid hashed completion artifact.

An offline replay of the earlier rejected provider return against `9ffdf74`
produced `residual_occluder` with 28,492 residual pixels, zero generated pixels,
and zero network calls. This is provisional pre-whole-branch evidence only; the
final private replay must be repeated after whole-branch review. The replay's
private source and returned image are intentionally not reproduced here.

These automated checks do not establish natural live-provider acceptance or
final editor acceptance. WPS/PowerPoint object movement, undo, explicit
save/discard, and reopen remain separate required evidence.

## Task 5: pre-review offline preparation snapshot at `565dc75`

The controller's final `npm run verify` exited 0 with 522 source tests and 522
compiled tests plus passing strict types, build, dependency audit, and whitespace
checks. Task 5 did not duplicate the full run. Its remaining focused calibration
suite passed 12 of 12 tests, including the independent labeled comparisons and
exact boundaries. The frozen constants at HEAD are unchanged from threshold
freeze commit `94ef0e3`: mask support 16, opaque interior alpha 240, sample
radius 3, minimum samples 8, maximum source p95 deviation 6, minimum palette
separation 36, maximum candidate distance 12, and maximum seam delta 12.

`npm pack --dry-run --json` exited 0 for `image-to-editable-pptx@0.3.0` with 54
entries, 147,937 packed bytes, 621,902 unpacked bytes, SHA-1
`21aa3177b66ca9e8f7145b441efb956db8e34665`, and integrity
`sha512-y6dM5NEYR5rZCOe50WzJG2Xc/T8djTYxx8SzS5PZyrR6oeh4U8He9MV+UngsuYM41m123B5sAuR36l1Yylhc2g==`.
The package listing excludes the private replay crops and returns, `.codex-tmp`,
tests, credentials, and the ignored implementation reports.

At that checkpoint this was offline gate evidence only. Whole-branch review was still running, so
the final saved bad-return replay and all live calls were deliberately withheld.
Read-only discovery says host OpenAI and host Gemini expose OCR, scene, and
completion capabilities; that is not request proof. API OpenAI and API Gemini
are unconfigured, and API Alibaba is configured but remains unproven for the new
source-locked completion input. No credentials or routing configuration were
introduced. Natural selection, generated-layer acceptance, offline rebuild,
three-preview inspection, exact-artifact WPS acceptance, and release readiness
therefore remain blocked pending the explicit post-review live gate.

## Task 5: post-review live acceptance at `1b0baaf`

The final whole-branch review found four bounded provider-adapter issues. They
were fixed and a focused re-review found no open findings. A fresh controller
`npm run verify` then passed 531 source tests, 531 compiled tests, strict types,
build, dependency audit, and whitespace checks. Task 5's focused appearance
suite passed 12 of 12 tests, and the frozen constants remain unchanged from
`94ef0e3`. The final package dry-run contains 54 entries (148,182 packed bytes,
623,067 unpacked bytes), SHA-1
`efe1e920a5f59c91f268aeea5176e3d2476b514b`, and no private diagnostic paths.

The final offline replay of the immutable earlier provider return made one
local provider callback and zero network calls. It rejected
`residual_occluder`, with 28,492 residual pixels, zero generated pixels, 101,901
outside-mask changes, and 63,857 visible changes. The crop and return SHA-256
values remain respectively
`a7b3c4e9cb078c0850b780bba50ffbbd8cdaa2af3601a5d4faa98a7a76374ede`
and `b02743b0623e971aebabb5535904b54bed6c19109f4ff20429f08990d51c7ee9`.

The one natural default-path run used the source fixture, two regional-analysis
slots and one completion slot. Host OpenAI succeeded once for OCR and once for
the base scene, then returned terminal `invalid_output` for the first regional
scene request. The run preserved its stopped routing report, made zero
completion requests, and created no normal output directory. This default path
did not pass.

A separately labeled zero-region isolation run made one real host OpenAI
completion request to `gpt-image-2`. Transport and 362-by-360 geometry passed,
but local quality rejected `ambiguous_appearance` with zero generated pixels;
the rear object remained in the background and no completion artifact was
published. This diagnostic is not represented as the default path passing.

One-shot direct checks reused the identical source-locked hole/protected input.
Host Gemini returned a valid 362-by-360 image from
`gemini-3.1-flash-image`, proving transport of the new input contract, but local
quality rejected `ambiguous_appearance` and published no artifact. The existing
Alibaba API executor returned `invalid_output` on its single call, so that route
remains unproven. API OpenAI and API Gemini remain unconfigured; no credentials
or configuration were added.

Independent inspection of the isolation run's three previews found only the
orange front-bar asset; the blue rear object remained in the background and no
generated rear-object completion existed. Its ordinary no-completion PPTX has
SHA-256 `bec9ba18b47499aa725f83eef9c541b318630d88f10f402887fb06dcda6c84c2`,
but it is not eligible for generated-object WPS acceptance. No WPS claim was
made and no substitute artifact was used.

The release gate is **BLOCKED**: the natural default path failed at regional
analysis, no available provider produced an accepted generated layer, offline
rebuild and WPS acceptance for that generated layer are therefore unavailable,
and API route coverage is incomplete. Read-only release checks also show
`origin` main/HEAD still at `29d203a`, no remote fallback branch or `v0.3.0`
tag, and npm `latest` still at `0.2.2`. No merge, push, tag, publication, or
cache installation was attempted.

## 2026-09-06: bounded regional repair and saved-return diagnosis

The regional prompt omitted the bbox wire format even though regional analysis
is a standalone request. A saved host OpenAI response supplied an invalid box
`[393,47,214,903]`; the parser correctly rejected `x2 must exceed x1`. This is
consistent with a width/height interpretation, not proof of the model's intent.
The pending prompt repair shares the full-slide integer corner-coordinate
contract and explicitly excludes `[x,y,width,height]`. Parser strictness,
routing advancement, and quality thresholds are unchanged.

A single real host OpenAI regional request with the repaired prompt, using the
same saved graph's selected crop, succeeded on `gpt-5.6-sol` and parsed three
nodes and one relation. This is an isolated regional check, not a rerun of the
natural end-to-end path. Private request/response/summary evidence is retained
under `.codex-tmp/release-v0.3.0/regional-root-cause-or4OG4/`; the earlier failure
is under `regional-root-cause-z3qIKm/` in the same private parent directory.
Fresh focused scene tests passed 33/33 and strict types passed. Fresh full
`npm run verify` exited 0 with 531 source and 531 compiled tests, strict types,
build, dependency audit, and whitespace checks.

Offline diagnosis of the saved Gemini return reproduced its rejection using
the production quality exports. All source appearance qualification checks
passed. Of 28,800 hidden pixels, 26,707 classified as rear, 1,717 as background,
376 as unknown, and none as residual front or alpha fringe. The first unknown
pixel's nearest palette distance was 13, above the frozen maximum of 12.
Thus the saved return violates the current fail-closed appearance contract;
these counts do not establish that the remaining contour/seam gates would pass.
The detailed private diagnosis is under
`.codex-tmp/release-v0.3.0/quality-root-cause-2026-09-06/`. The precise ChatGPT
completion pixels cannot be diagnosed because its returned bytes were not saved.

No thresholds were tuned to this live sample. Any anti-aliasing/color tolerance
policy change needs a separately agreed design and independent labeled
calibration examples. No Alibaba requests were made in this continuation;
the user's suspected token limit remains unverified. Release remains
**BLOCKED**: no accepted live generated layer, generated-artifact offline
rebuild, or corresponding WPS acceptance has been established. No merge, push,
tag, npm publication, or installed-cache change was made.
