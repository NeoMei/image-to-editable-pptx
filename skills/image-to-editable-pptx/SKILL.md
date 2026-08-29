---
name: image-to-editable-pptx
description: Convert a PNG or JPEG slide image into a high-fidelity PPTX with editable text and safely extracted semantic PNG layers. Use when the user wants to edit an image-based slide while preserving uncertain content in the background.
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

New `analyze` and `run` operations need `DASHSCOPE_API_KEY` and `DASHSCOPE_WORKSPACE_ID` in the process environment. Never echo, record, commit, paste into a command, or copy these values into a response. The CLI intentionally has no API-key, workspace, Authorization, provider-secret, or base-URL flags.

Explain before live analysis that the slide is sent once for OCR and once for full-page scene analysis. The generic analyzer may also send at most 8 selected crops for regional refinement and at most 4 eligible masked crops for occlusion completion. Both optional stages are bounded and can be disabled independently with zero; there is no unlimited mode.

## Run the converter

For a new self-contained manifest v2 analysis package:

```bash
npm run cli -- analyze <source.png> --out <analysis-dir> [--max-region-analysis <0..8>] [--max-occlusion-completions <0..4>] [--record]
```

Build from that verified package offline. This command must not receive the source image, analysis/network limit flags, `--record`, or credentials:

```bash
npm run cli -- build --analysis <analysis-dir> --out <output-dir> [--required-text-count <n>]
```

For a combined network analysis and local build:

```bash
npm run cli -- run <source.jpg> --out <output-dir> [--max-region-analysis <0..8>] [--max-occlusion-completions <0..4>] [--required-text-count <n>] [--record]
```

Defaults are 8 regional analyses and 4 occlusion completions. `0` disables the corresponding stage. Use `--required-text-count` only when the expected OCR text count is independently known.

Only a legacy analysis package v1 requires its original image again. Keep that compatibility route explicit:

```bash
npm run cli -- build-v1 <source.jpeg> --analysis <legacy-analysis-dir> --out <output-dir> [--required-text-count <n>]
```

Do not use `build-v1` for manifest v2, and do not suggest that v2 needs the image again. `analyze` and `run` retain `--image <path>` only as a compatibility alias for old scripts; prefer the positional image form above.

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
