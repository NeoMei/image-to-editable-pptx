# Source-locked occlusion completion

## Status and decision

The user approved the direction on 2026-09-05: remove occluder content from the
editable model input, request the rear object explicitly, and locally compose
validated hidden pixels onto immutable source-visible pixels. This written
design awaits review before implementation planning. It does not claim working
implementation, editor acceptance, or release readiness.

## Evidence and problem

See `docs/verification/2026-09-05-natural-occlusion-mask-fix.md`. Natural selection
and host transport now work. A captured `gpt-image-2` response had correct
363-by-361 geometry but changed 63,857 of 64,117 protected pixels and retained
the orange occluder rather than reconstructing the blue circle. The current
gate correctly rejected it.

Two limitations remain: model instructions are not a pixel-write boundary, and
`candidate-kind` plus `relation-count` does not identify what to reconstruct.
Mask decoding and account discovery are separate, previously repaired issues.

## Alternatives

1. **Source-locked local composition (selected).** Treat the returned image as
   untrusted candidate content, not a replacement crop. Local code owns pixel
   preservation and quality acceptance. This requires changing the completion
   gate's interpretation of provider output and updating its tests.
2. **Keep strict raw-return equality.** Retain current conservative behavior;
   unsuccessful objects stay in the background. Safe, but the observed host
   image response cannot be accepted.
3. **Prompt-only retries or quality-driven provider fallback (not selected).**
   Neither establishes pixel preservation. Repeated attempts increase cost and
   would change the approved routing policy without solving this boundary.

## Scope and invariants

- Preserve the existing ordered routing for OCR, scene, and completion:
  host OpenAI, API OpenAI, host Gemini, API Gemini, API Alibaba.
- Preserve unavailable/auth/retryable-only routing advancement, terminal refusal
  and malformed-output behavior, request budgets, timeout ownership, and the
  offline `build` boundary. Quality rejection does not advance providers.
- Keep canonical candidate-sized crops, accepted graph relations, complete
  occluder masks, and opposing continuing-contact evidence as preconditions.
- Never enlarge the hidden region to make a failed sample pass. Never use model
  labels as geometry or permission to edit other objects.
- Final visible RGBA must equal the original source byte-for-byte. Generated
  support must be disjoint from visible support and contained in the proven
  hidden mask. Everything outside their union is transparent in the asset.
- Every generated layer remains `reviewRequired: true`. No automatic release,
  installation update, new credentials, or added vision-verifier calls.

## Data flow and responsibility

### 1. Construct an explicit rear-object request

`pipeline.ts` supplies bounded context from the existing accepted scene graph:
rear node IDs, labels and roles, plus the IDs and labels of its accepted front
occluders. Treat labels as quoted untrusted data, not instructions. Cap labels
and counts; omit excess descriptive text without dropping required mask checks.
The prompt identifies the rear object, says the missing region must continue
that object, and prohibits recreating front occluders, text, or a collage.

The completion gate retains the immutable original crop separately. After
deriving hidden evidence and subtracting occluders from visible support, create
a request copy with RGBA zeroed only inside the proven hidden mask. The source
buffer is never mutated. The transparent hole is the requested missing content,
not a request to preserve an orange bar. Do not send the original unmasked crop
as an extra competing reference image.

Adapters retain responsibility for supported canvas padding, mask polarity,
transport, MIME/geometry checks, and reversing padding. All provider paths must
receive the same logical editable crop. A provider unable to consume this input
must be classified honestly; do not silently substitute a whole-image redraw.

### 2. Validate candidate content before composition

Keep the returned normalized image private and unmodified during validation.
Geometry mismatch, invalid metadata, malformed images, and routed terminal
errors retain current handling. Count returned changes outside the mask for
diagnostics, but do not interpret those bytes as proposed writes to the source.

Extract generated support only inside the proven hidden mask. Do not use
"any changed opaque pixel" as sufficient proof of rear-object content: an
unchanged orange bar, newly shaded bar, background fill, or opaque rectangle
must not become a generated rear layer.

The first implementation is deliberately conservative: automatic acceptance
requires enough source-visible support to distinguish rear appearance from
occluder/background appearance and to judge the seam. Initially support
low-variation surfaces with separable local colors. Ambiguous same-color layers,
complex textures, transparent/glowing boundaries, or insufficient samples are
rejected rather than fitted with synthetic geometry or new model calls.

Source-local checks must include:

- Rear-support consistency and sufficient samples on opposing contacts.
- Generated appearance consistent with rear support; no residual front-object
  color/structure where the two are distinguishable.
- Removal of identifiable background pixels from generated asset support.
- Boundary color/alpha continuity, not merely connected-component connectivity.
- Existing required-contact bridging, single continuous contour, hidden-mask
  containment, and candidate geometry constraints.

Numerical appearance/seam thresholds are implementation-plan deliverables:
calibrate them on independent labeled positive/negative offline fixtures,
document their units and boundary tests, then freeze them before live tests.
Do not tune thresholds against a rejected live response. This design makes no
claim that these tests recover unknown ground-truth hidden pixels.

### 3. Compose and independently verify

Build a fresh transparent output buffer. Copy original source RGBA at visible
support, and candidate RGBA only at accepted hidden support. Never copy returned
pixels elsewhere and never recolor visible edges to conceal a seam.

Run an independent final invariant check: source-visible equality, disjoint
masks, generated containment, dimensions, alpha support, and contour continuity.
Offline `buildSemanticLayers` keeps its provenance, source-pixel, and final
recomposition validation. A local appearance failure or reconstruction failure
keeps this candidate in the background; no partially accepted asset is published.

## Contracts, provenance, and diagnostics

Preserve the public `CompletedCandidate` artifact fields and v2 package loading.
`sourceCropSha256` always hashes the immutable original crop, never the cleared
request. Visible/generated masks and final asset retain their own hashes.
Existing packages remain readable; no silent rewrite of previous artifacts.

Introduce a private discriminated completion outcome for internal coordination:
accepted with artifact/metrics, skipped with reason, or rejected with reason.
Keep the current optional-result wrapper for callers that only need an asset.
Routed terminal failures still throw and must not be converted into skips.

Persist bounded reason codes and numeric metrics in a separately versioned
local diagnostics sidecar, not new undeclared fields in strict v2 ledgers.
Offline build does not trust or require this sidecar. Suggested categories are
insufficient evidence, ambiguous appearance, geometry, residual occluder,
seam mismatch, contour mismatch, and invariant failure. A transport-success
record and a quality-rejection record must coexist without implying acceptance.

Raw crops/model outputs are opt-in private diagnostic artifacts, never automatic
logs. Do not retain credentials, signed URLs, arbitrary exception strings, or
unbounded scene text. Respect existing output ownership and atomic publication.

## Validation and acceptance

Use test-driven changes for each contract change. Replace tests that demand
raw-return equality with tests proving immutable final source pixels; retain
negative tests for bad content inside the hidden region. Required cases include:

1. Source/request buffer separation and correct hole/mask polarity through each
   adapter; original source hashes remain unchanged.
2. Correct hidden content plus arbitrary outside-mask provider changes produces
   an accepted source-locked asset; outside changes never appear in the output.
3. Original or shaded occluder, wrong-color fill, background-only output, shifted
   object, seams, disconnected fills, and ambiguous appearance are rejected.
4. Tampered provenance, overlapping masks, invalid geometry, missing relations,
   one-sided contacts, budgets, timeouts, and terminal refusals stay fail-closed.
5. Real completion result through package write/read, offline build, semantic
   layer acceptance, and all three QA previews; not only a provider stub count.

Run full source/compiled tests, types, build, audit, and package inspection.
Independently review the patch before release preparation. Live acceptance must
show a naturally selected completion, an accepted generated layer, no occluder
residue, source-locked visible pixels, and successful offline reconstruction.
Explicitly report any disabled regional-analysis budget. Host/API/provider
coverage is reported separately; one provider's success proves no other route.

For the resulting artifact, perform real WPS text edit and generated-object
movement, undo, explicitly save/discard, and reopen. Preserve `reviewRequired`
and record the exact artifact hash. Only then assess release readiness; GitHub,
npm, and installed-cache changes remain separately authorized steps.
