# Task 3 Report: Tight OCR Text Masks

## Status

Implemented and committed as `0a6d36ace16400988ec55b27e6807c88b71e9f29` (`feat: build tight OCR text masks`).

## Implementation

- Added `buildTightTextMask(source, element, options)` with the required result and option contracts.
- Decodes the source through Sharp as raw RGBA and clamps floor/ceil OCR bounds to the source canvas.
- Samples only the one-pixel ring immediately outside the OCR box, derives channel medians and per-channel median absolute deviations, and rejects fewer than eight samples or any MAD above 18.
- Marks only in-box pixels whose maximum RGB channel distance from the sampled surface meets the threshold.
- Dilates only marked pixels. Requested dilation is validated, then capped with `min(requested, floor(textHeight / 4))`; oversized dilation cannot spread to the tested OCR corners or neighboring structure.
- Emits a full-canvas one-channel black/white PNG and reports the unique post-dilation pixel count and sampled surface RGB.
- Conservatively throws for an inconsistent/undersampled surface, no contrasting pixels, or a threshold that would select the full OCR box.

## TDD Evidence

### RED

Command:

```bash
node --import tsx --test tests/text-mask.test.ts
```

Result: exit 1. The test process failed for the intended reason: `ERR_MODULE_NOT_FOUND` for the not-yet-created `src/image/text-mask.js`.

### GREEN

Command:

```bash
node --import tsx --test tests/text-mask.test.ts
```

Result: exit 0; 7 tests passed, 0 failed. Covered exact glyph selection, incompatible surfaces, height-capped dilation, insufficient safe-ring samples, absent glyph contrast, unsafe full-box selection, and invalid options.

### Type Check

Command:

```bash
npm run lint:types
```

Result: exit 0; `tsc -p tsconfig.json --noEmit` completed without diagnostics.

### Full Source Suite (run once before commit)

Command:

```bash
npm test
```

Result: exit 0; 92 tests passed, 0 failed, 0 skipped, duration 3142.617083 ms.

## Files

- `src/image/text-mask.ts`
- `tests/text-mask.test.ts`

No candidate, provider, pipeline, or unrelated source files were modified.

## Self-review

- Re-read the task brief and checked each required processing step against the committed implementation.
- Checked the staged patch with `git diff --cached --check`; no whitespace errors.
- Inspected commit metadata and worktree state after commit; the tracked worktree was clean.
- Mutation check: removing contrast selection breaks the exact-pixel/no-glyph tests; weakening surface rejection breaks the inconsistent/undersampled tests; removing the height cap breaks the oversized-dilation test; accepting unsafe thresholds breaks the full-box guard test; removing validation breaks the invalid-option test.
- Dilation is clipped to the OCR/foreground bounds and originates only from detected foreground pixels; it never substitutes an OCR rectangle as the mask.

## Concerns

- Intentional conservative behavior: OCR boxes at a source edge may be rejected when fewer than eight safe ring pixels remain. This avoids guessing a surface and erasing a panel or bar.
- Fractional dilation values are accepted by the required finite/non-negative contract and floored to an integer pixel radius after applying the text-height cap.

## Fix Review

### Review findings and root causes

1. `dilate()` clipped writes only to the source canvas, so foreground at an OCR edge could expand into neighboring content. The full-box safety check ran before dilation, leaving post-dilation over-mask undetected.
2. Sharp encoded the one-channel raw input as an sRGB three-channel PNG unless the output colorspace was explicitly set to `b-w`. A read-only local probe returned `{"channels":3,"rawChannels":3}` before the fix.

### RED

Command:

```bash
node --import tsx --test tests/text-mask.test.ts
```

Result: exit 1; 10 tests total, 6 passed and 4 failed for the intended review findings:

- metadata reported 3 channels instead of 1;
- central 2x2 glyph plus dilation did not reject 100% box coverage;
- dilation set the pixel immediately outside the OCR box to 255 instead of 0;
- a competing structural region covering 14/16 pixels did not reject.

### GREEN

Command:

```bash
node --import tsx --test tests/text-mask.test.ts
```

Result: exit 0; 10 tests passed, 0 failed, 0 skipped. The metadata assertion observed exactly one channel.

### Required verification

Command:

```bash
npm run lint:types
```

Result: exit 0; `tsc -p tsconfig.json --noEmit` completed without diagnostics.

Command:

```bash
git diff --check
```

Result: exit 0 with no output (no whitespace errors).

### Fix implementation and self-review

- Added `MAX_MASKED_BOX_RATIO = 0.85` and reject when post-dilation in-box coverage is greater than or equal to that limit.
- Restricted every dilation write to the clamped OCR bounds; no mask pixel is created outside the box.
- Forced the encoded PNG through Sharp's `b-w` colorspace and changed pixel tests to honor decoded channel counts.
- Kept the existing exact pre-dilation full-box guard and all required-text failure paths.
- No candidate, provider, pipeline, or unrelated source files were modified.
