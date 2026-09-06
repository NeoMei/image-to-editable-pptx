---
name: image-to-editable-pptx
description: Use when a user wants to convert or edit a PNG or JPEG slide image as a high-fidelity PPTX while preserving uncertain content safely in the background.
---

# Image to Editable PPTX

Reconstruct one image-based slide with fidelity first. OCR text becomes editable text; semantic foreground objects and text backings become movable PNG assets only when their ownership, mask, repair, and recomposition checks pass. Unsafe candidates use the safe fallback and remain pixel-identical in the background.

This Agent Skill supports Codex and OpenCode on macOS or Linux with Node.js 22.6 or newer.

## Resolve the installation

1. Resolve the physical path of this `SKILL.md`, following any symbolic link.
2. Treat the plugin root as two directory levels above its physical containing directory.
3. Confirm that root contains `package.json`; run package commands there.
4. If dependencies are absent, run `npm ci --include=dev` in that root. Do not install global packages.
5. Put analysis and final output in durable user/project directories, never inside the installed plugin cache.

## Validate the source

Accept exactly one static PNG, JPG, or JPEG image. The decoder uses magic bytes rather than trusting the extension. Reject inputs outside any of these limits:

- maximum file size: 50 MiB;
- width and height: each 64 through 8192 pixels;
- maximum decoded area: 40,000,000 pixels;
- maximum aspect ratio: 56:1;
- no animation or multipage image.

The slide layout preserves the accepted canvas aspect ratio; it is not limited to 1280×720 or 16:9.

## Credential boundary

ChatGPT host completion is suspended in both automatic OpenCodex and file-bridge routes. Use the host only for OCR and scene analysis. Do not advertise or service `completion`, even if an old manifest or registered image tool offers it. Completion uses OpenAI API then Alibaba API; if neither is configured (all candidates are missing), preserve the safe background and report that hidden-layer completion was unavailable. Configured API failures still follow the original fallback and terminal-exhaustion rules. Do not repair this by retrying host prompts or weakening quality checks.

Gemini is not a supported provider for OCR, scene analysis, or completion. Google/Antigravity sign-in, Gemini API keys, and legacy Gemini model overrides do not create a candidate. If only those are available, report no supported live provider; do not service Gemini requests. Historical Gemini records in an existing analysis package may be read for offline build only.

New `analyze` and `run` operations need at least one real host capability or one complete API credential set. Without `--host-bridge`, the CLI automatically discovers a running local OpenCodex public API using `ocx access endpoints --json`; existing signed-in OpenAI accounts become host candidates. Missing official API keys do not disable these local hosts. Registered host tools can alternatively be exposed through an explicit `--host-bridge`, which takes precedence. API candidates use `OPENAI_API_KEY`, or both `DASHSCOPE_API_KEY` and `DASHSCOPE_WORKSPACE_ID`. Missing keys skip only that API candidate. Never echo, record, commit, paste into a command, copy into bridge files, or copy these values into a response. The CLI intentionally has no API-key, workspace, Authorization, provider-secret, or base-URL flags. Do not use browser/UI automation as a provider fallback and do not harvest cookies, `localStorage`, session data, browser profiles, OAuth files, or internal host/session tokens for API access.

For API routes, the current defaults are `gpt-4.1` / `gpt-image-2`, and `qwen3.5-ocr` / `qwen3-vl-plus` / `wanx2.1-imageedit`. OpenAI defaults may be overridden with `OPENAI_ANALYSIS_MODEL` and `OPENAI_IMAGE_MODEL`. File-bridge successes must use actual registered-tool model metadata. OpenCodex records the response model when present, otherwise the model of its successful explicit request; a catalog label alone is never execution evidence.

Explain before live analysis that the pipeline makes one logical OCR request and one logical full-page scene request. Fallback candidates and bounded API retries may transmit the same slide more than once; actual host invocations and API attempts are recorded separately in `routing.transportAttempts`. The generic analyzer may also make at most 8 logical requests for selected regional crops and at most 4 for eligible masked occlusion-completion crops. Both optional stages are bounded and can be disabled independently with zero; there is no unlimited mode.

## Choose the available host connection

When local OpenCodex is installed and running, use the ordinary `analyze` or `run` command without creating a file bridge. Discovery checks a literal loopback endpoint and matching vision-capable models; the actual request still determines availability. The default is `openai/gpt-5.6-sol` for OCR and scene analysis; host completion is disabled. `OPENCODEX_OPENAI_ANALYSIS_MODEL` selects other advertised analysis models. `IMAGE_PPT_OPENCODEX=off` disables this discovery. A stopped, protected, or absent local API skips these host candidates; do not repair account configuration or extract credentials without authorization. Offline `build` never performs discovery.

Read [`docs/host-routing.md`](../../docs/host-routing.md) for the local transport and failure semantics. If using registered host tools instead, follow the file bridge procedure below.

### Registered-tool file bridge

Before requiring provider keys, inspect the tools actually registered in the current host. A model catalog entry, ordinary agent reasoning, browser/UI automation, or an image-editing tool is not an OCR/scene JSON capability. Declare only the exact `openai` OCR and scene operations a registered tool can perform with the request's local PNGs and prompt. Omit absent operations and never invent model output or extract consumer web-session credentials.

Read [`docs/host-routing.md`](../../docs/host-routing.md) completely before creating or servicing a bridge. It is the normative shipped reference for the capability manifest, request and response schemas, coordinate systems, failure codes, privacy boundary, atomic publication, routing semantics, and child-monitor loop.

The host agent itself performs this loop because only it can invoke the registered tools in its session. There is intentionally no standalone shell bridge-servicer command for host tools.

The concrete loop is:

1. Create a private existing directory with mode `0700` outside the plugin cache and output directories. Write `capabilities.json` with mode `0600` from live tool discovery. The packaged copyable OCR/scene example is `docs/examples/host-capabilities.json`.
2. Start `analyze` or `run` with `--host-bridge <private-dir>` as a running child. Do not wait for child completion before servicing requests.
3. Poll `requests/request-*/request.json` and the child status. Maintain a set of served `requestId` UUIDs. After the atomically published request appears, validate it and read only its named local PNG inputs.
4. Invoke the declared registered tool for `provider` and `operation`. OCR returns pixel-coordinate JSON text; scene returns normalized-thousandths JSON text. Do not invoke a tool for legacy completion requests; return `unavailable`. Use the effective model label from tool metadata. If the tool cannot produce the contract, return a classified failure, not fabricated content.
5. Write the exact version-1 response to a mode-`0600` temporary file in that request directory, then rename it to `response.json`. Never download arbitrary URLs or expose the slide through a public directory.
6. Continue for new unserved request IDs until the child exits. On servicing failure, terminate the child and retain only explicitly owned diagnostic data.

OCR and scene use `host-openai`, `api-openai`, `api-alibaba`. Completion skips `host-openai` without invoking it and uses `api-openai`, `api-alibaba`; the skipped host ledger slot is `unavailable` / `missing_candidate`. Routing is serial with one independent forward-only sticky cursor per operation. Only `unavailable`, `auth_unavailable`, and `retryable_exhausted` advance; `policy_refused`, `invalid_input`, `invalid_output`, and `local_failure` stop the run. A host raw result becomes router success only after the operation adapter validates its content and geometry.

## Run the converter

For a new self-contained manifest v2 analysis package:

```bash
npm run cli -- analyze <source.png> --out <analysis-dir> [--host-bridge <private-dir>] [--max-region-analysis <0..8>] [--max-occlusion-completions <0..4>] [--record]
```

Build from that verified package offline. This command must not receive the source image, analysis/network limit flags, `--record`, or credentials:

```bash
npm run cli -- build --analysis <analysis-dir> --out <output-dir> [--required-text-count <n>]
```

For a combined network analysis and local build:

```bash
npm run cli -- run <source.jpg> --out <output-dir> [--host-bridge <private-dir>] [--max-region-analysis <0..8>] [--max-occlusion-completions <0..4>] [--required-text-count <n>] [--record]
```

Defaults are 8 regional analyses and 4 occlusion completions. `0` disables the corresponding stage. Use `--required-text-count` only when the expected OCR text count is independently known.

Only a legacy analysis package v1 requires its original image again. Keep that compatibility route explicit:

```bash
npm run cli -- build-v1 <source.jpeg> --analysis <legacy-analysis-dir> --out <output-dir> [--required-text-count <n>]
```

Do not use `build-v1` for manifest v2, and do not suggest that v2 needs the image again. `analyze` and `run` retain `--image <path>` only as a compatibility alias for old scripts; prefer the positional image form above.

In `analysis-ledger.json`, `requests` are logical pipeline operations, `routing.operations` shows candidate decisions for each logical operation, and `routing.transportAttempts` counts actual host invocations and individual API retry attempts. Missing candidates add an attempt disposition but no transport. Report these measures separately.

## Review the result

Read `manifest.json` and require `manifestVersion: 2` for the generic workflow. Report accepted editable-text and PNG-asset counts, rejected/fallback decisions, and every asset with `reviewRequired: true`.

Review these files beside the source:

- `recomposition-preview.png` for whole-slide visual fidelity;
- `layer-review.png` for individual transparent assets;
- `exploded-preview.png` for separability and z-order;
- `clean-background.png`, `removal-mask.png`, `assets/*.png`, `run-ledger.json`, and `slide-editable.pptx` for final evidence.

Generated hidden regions receive a visible generated-region marker only in QA previews. The exported PNG asset and PPTX must remain unmarked. Treat `reviewRequired` as a manual review requirement, not automatic rejection.

Text backing and color-strip layers remain movable PNG assets beneath editable text; they are not native PowerPoint shapes. Do not claim otherwise. If a backing, icon, connector, compound object, or occlusion completion cannot pass validation, accept the safe fallback in the background rather than forcing a low-fidelity layer.

For delivery, open the PPTX in the user's target PowerPoint/WPS client. Move a representative foreground object and a text-backing asset, edit the associated text, undo the changes, explicitly save or discard, close, reopen, and report the observed state.

## Failure and publication boundary

- New analysis output must be absent or empty.
- Never overwrite an unmarked output directory or bypass canonical-path and ownership checks.
- Keep the previous successful output when a rerun fails; inspect the retained failed-run evidence.
- Offline v2 `build` must succeed from the self-contained analysis package without loading live credentials or calling a provider.
- Do not describe a bitmap-only import as editable, and do not equate this workflow with Canva Magic Layers.
