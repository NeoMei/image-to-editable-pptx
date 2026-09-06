# OpenCodex host repair verification

## Scope and cause

Branch: `codex/model-fallback`, repair based on `ea7e820`.

The previous Alibaba smoke omitted `--host-bridge` and had no OpenAI/Gemini API
keys. Its ledger recorded `missing_candidate` with zero GPT/Gemini transports;
this was missing host integration, not evidence of upstream account failure.

The repair automatically discovers the public local OpenCodex endpoint for CLI
`analyze`/`run`, with explicit file-bridge precedence. It does not install,
restart, reconfigure, or extract credentials from OpenCodex. Public image-routing
settings are checked to avoid custom/xAI overrides inside `host-openai`.

Real protocol probes found and fixed two compatibility differences:

- ChatGPT Responses requires `stream: true`. Completed SSE envelopes may have
  empty `output`; completed output-item events supply the actual result.
- ChatGPT image edits require JSON `images[].image_url`, not the official
  Platform adapter's multipart form. Source and both masks are sent as labeled
  image references; returned pixels still undergo geometry and pipeline QA.

## Automated verification

- `npm run verify`: 441 source tests and 441 compiled tests passed; types,
  build, and whitespace checks passed.
- Dependency audit retained the existing two unreachable `image-size`
  exemptions, review due 2026-10-03. No dependency change was made.
- 16 dedicated bridge tests cover no-key discovery, strict loopback endpoints,
  streaming extraction, refusal/truncation, HTTP failure classification,
  bounded image results, source/mask transmission, split text/multiple images,
  opaque artifact retrieval, image-route guards, and CLI/offline boundaries.
- `npm pack --dry-run --json`: 51 entries, including the new bridge module.
- Skill validator passed. An independent guidance application first reproduced
  the old host-skipping instructions, then selected automatic OpenCodex with
  the corrected instructions.
- Independent code review approved the final change under stable proxy routing
  settings. Its oversized-response and split-image findings have regression
  coverage; custom image routing is guarded.

## Real provider evidence

No official OpenAI/Gemini API keys were used. The fixture was the repository's
320×180 synthetic `tests/fixtures/semantic/canvas-16x9.png`, not user content.
Acceptance output root: `/tmp/image-ppt-ocx-repair.jGyFOM`.

1. Default CLI `analyze` selected `host-openai / gpt-5.6-sol` for OCR and scene,
   one successful transport each, without `--host-bridge`. Offline `build`
   produced `openai-output/slide-editable.pptx` and all three QA previews.
2. With only the OpenCodex OpenAI analysis selector set to an unadvertised model,
   CLI `run` selected `host-gemini / gemini-3.1-pro` for OCR and scene, one
   successful transport each. OpenAI candidates were skipped as expected.
   It produced `gemini-output/slide-editable.pptx` and the three QA previews.
3. Direct real completion probes used a 64×64 synthetic blue crop and two masks.
   `gpt-image-2` returned a validated 64×64 PNG after padding/cropping.
   `gemini-3.1-flash-image` returned an opaque loopback JPEG artifact that also
   passed decoding/normalization. An earlier Gemini probe returned no usable
   image and was correctly rejected; success is not guaranteed on every prompt.
4. After the routing guard was added, live discovery still reported both
   providers' OCR, scene, and completion capabilities available.

PPTX SHA-256:

- OpenAI: `b561b7afeffdb77beb17f81b66807269edd8b16c4465b8ebaad52a8ef4bd45d8`
- Gemini: `00d761f95ac2d058cecc17bf73b07f7247a4d0bc5bf92891cf6d644c717fc7dd`

These are transport, schema, geometry, and CLI/build checks. The no-text fixture
does not prove editable text quality; completion was exercised directly, not
through a naturally selected occlusion region. No visual/WPS acceptance,
main-branch merge, remote push, release, or installed plugin-cache update is
claimed. Alibaba's earlier live evidence remains separate.
