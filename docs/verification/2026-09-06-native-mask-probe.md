# Single-request ChatGPT mask compatibility probe

## Scope and hypothesis

The user approved exactly one diagnostic image-edit request after the two
reference/prompt ablations failed. The hypothesis was that an independent
`mask.image_url` could provide useful hidden-region guidance through the existing
ChatGPT host. This was not authorization to change production routing or release.

The public OpenAI Images API documents this JSON mask field. The inspected
OpenCodex 2.43.0 OpenAI relay forwards JSON without removing fields, but the
official Codex `ImageEditRequest` type does not expose a mask. Platform API
support therefore does not establish ChatGPT backend support.

## Method

Reuse the natural-path crop, source scene description, local protection mask,
model `gpt-image-2`, and 816-by-816 padded canvas. Move the prepared hidden alpha
mask from the reference array to `mask.image_url`; send only the source as a
reference. Change only the corresponding reference-description wording. Keep
the original rear/front scene labels and all quality thresholds unchanged.

Offline preflight verified the unchanged padded-source hash and 29,120 editable
mask pixels. The isolated wrapper allowed one image POST, with no retries,
provider fallback, new OCR/scene inference, credentials or configuration changes.
No Alibaba request or production edit was made.

## Result

Exactly one inference request returned HTTP 200 and a normalized 363-by-364 image.
Visual inspection shows two orange bars and a dark center, not a completed blue
circle. The unchanged production assessment rejected it as `residual_occluder`.

- Hidden pixels: 29,120; rear-classified: 0; front-classified: 3; unknown: 29,117.
- Returned source-visible pixels changed: 64,117 of 64,117.
- Returned pixels outside the hidden region changed: 103,012.

These classification counts are not accepted generated layers. In particular,
only three front-color matches do not mean only three orange pixels are present.
No returned pixels were promoted into an analysis package or PPTX.

## Evidence and decision

Private artifacts are in `.codex-tmp/release-v0.3.0/native-mask-probe-ZZQJbU/`:
scope, dispatch count, effective JSON request, HTTP status, input/masks/return,
result and offline quality replay. The returned PNG SHA-256 is
`7bc1afd9adb9e0cc8a22487f93e01169e0abd49fa9c9c91b47bb9b8221229678`.

HTTP success proves the request was accepted, not that the backend interpreted
the mask; an unknown field could have been ignored. This single observation
cannot establish universal host incapability, but it provides no qualifying
completion. The approved request budget is exhausted. Do not retry, loosen QA,
or publish completion as working. No generated-artifact WPS test was applicable.

References: [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/edit),
[Codex request type](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/images.rs).
