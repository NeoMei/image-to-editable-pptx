---
name: image-to-editable-pptx
description: Convert a 1280×720 slide PNG into a high-fidelity editable PPTX using Alibaba Cloud Model Studio OCR and vision analysis plus deterministic local reconstruction. Use when the user wants editable text and only reliably extracted movable icons from an image-based slide.
---

# Image to Editable PPTX

Reconstruct the supplied slide image with visual fidelity first: every accepted OCR line becomes editable text, reliably isolated icons may become movable PNG layers, and panels, bars, borders, textures, and uncertain graphics remain in the background.

## Run the converter

1. Resolve the plugin root as two directory levels above the directory containing this `SKILL.md` file. Work from that plugin root for package commands.
2. Require Node.js 22.6 or newer. If dependencies are absent, run `npm ci --include=dev` in the plugin root. Do not install global packages.
3. Confirm the source is an exact 1280×720 PNG. Explain the current single-slide limitation if the user provides another format or size.
4. Choose a durable output directory outside the installed plugin cache. It must not be the source image or an ancestor of the source, and it must not be the current project root or one of its ancestors. Never overwrite an unmarked directory.
5. For a new analysis, require `DASHSCOPE_API_KEY` and `DASHSCOPE_WORKSPACE_ID` in the process environment. Never echo, record, commit, or copy either value into a command, file, or response. Tell the user that the full slide image is sent once to `qwen3.5-ocr` and once to `qwen3-vl-plus`; reconstruction after analysis is local.
6. Run from the plugin root:

   ```bash
   npm run cli -- run --image <source.png> --out <output-dir> [--required-text-count <n>]
   ```

   Use `--required-text-count` only when the expected OCR text count is known. If the user supplies a compatible analysis directory, use the offline form instead:

   ```bash
   npm run cli -- build --image <source.png> --analysis <analysis-dir> --out <output-dir> [--required-text-count <n>]
   ```

7. Report the generated `*-editable.pptx` path and the accepted text/icon counts from `manifest.json`. Do not describe a bitmap-only import as editable. For delivery, open or render the PPTX in the user's target PowerPoint/WPS client and verify that representative text objects can actually be edited.

## Failure boundary

Keep the previous successful output when a rerun fails. Inspect the retained failed-run evidence instead of bypassing ownership checks or required-text validation. Do not switch to generative inpainting unless the user explicitly requests a different fidelity tradeoff.
