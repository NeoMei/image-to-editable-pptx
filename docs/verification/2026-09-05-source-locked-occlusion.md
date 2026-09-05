# Source-locked occlusion verification

## Task 2: offline appearance calibration

This checkpoint covers only the source-local appearance helper. It does not
integrate the helper into the completion gate, call a provider, validate a live
response, publish an artifact, or establish release readiness. Constants were
selected and frozen against independently labeled synthetic raster fixtures
before any live acceptance work.

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

| Quantity | Units | Boundary examples | Initial result | Frozen value |
| --- | --- | --- | --- | --- |
| Samples per source appearance class | unique opaque pixels | 8 background samples qualified; 7 failed with `insufficient_evidence` | separated the labeled pair | minimum 8 |
| Source variation | p95 of per-pixel maximum RGB-channel distance from the per-channel median | delta 6 qualified; delta 7 failed with `ambiguous_appearance`; the larger gradient also failed | separated uniform/gradient fixtures | maximum 6 levels |
| Source palette separation | maximum RGB-channel distance between class medians | 36 qualified; 35 and identical rear/front colors failed with `ambiguous_appearance` | separated the labeled pair | minimum 36 levels |
| Candidate palette distance | maximum RGB-channel distance from a source class median | rear delta 12 accepted; delta 13 and a tied class failed with `ambiguous_appearance` | separated the labeled pair | maximum 12 levels |
| Candidate interior alpha | 8-bit alpha | 240 accepted; 239 and the glowing edge failed with `ambiguous_appearance` | separated opaque/fringe fixtures | minimum 240 |
| Contact seam delta | maximum RGB-channel distance for adjacent source-visible/generated pixels | 12 accepted; 13 failed with `seam_mismatch` | separated the labeled pair | maximum 12 levels |
| Mask support | 8-bit mask/alpha | inherited support handling, not recalibrated here | preserves the existing contract | minimum 16 |

Opaque candidate pixels classified as background are excluded from generated
support. Transparent returned pixels do not create support. Front-classified
pixels fail as `residual_occluder`; unknown opaque pixels and unreliable alpha
fringes fail as `ambiguous_appearance`. Missing contact continuation and
disconnected rear-colored islands fail as `contour_mismatch`. Returned changes
outside the hidden mask and on visible support are counted only as diagnostics;
the helper does not copy or composite any returned pixels.

This calibration is deliberately finite: flat, low-variation, locally separable
colors at the tested raster scales. It is not evidence for textures, gradients,
glows, transparent boundaries, or semantically complex objects. In particular,
a uniform-color fake geometry can satisfy color checks without being the correct
hidden object. Existing contact/contour gates, final recomposition invariants,
and human review remain required. The rejected live orange-bar response was not
used to choose or adjust any threshold.
