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
