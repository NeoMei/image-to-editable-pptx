# Bounded ChatGPT completion ablations

## Scope and controls

The user approved at most two diagnostic completion requests against the saved
natural-path crop from `chatgpt-acceptance-GqPX6a`. Both used the existing public
OpenCodex host, unchanged `gpt-image-2` model and 816-by-816 padded canvas, and
the same 363-by-364 source crop, hidden mask, protection mask and geometry.
No new OCR or scene requests, API/Alibaba calls, production edits, account
changes, or threshold adjustments were made.

The diagnostic fetch wrapper changed only these conditions:

- **A — foreground description ablation:** remove `frontOccluders` from the
  quoted scene JSON; preserve the rear description, other prompt instructions,
  source reference, and both mask references.
- **B — reference-packaging ablation:** preserve the original rear/front
  descriptions but send the source reference alone. Update the reference-count
  and missing-region wording to describe that single-image input accurately.
  Thus this is a packaging-plus-matching-instructions test, not a claim that
  every prompt byte was held constant. Both masks remain in local validation.

Each variant ran once. The earlier baseline was not rerun, so these observations
cannot isolate stochastic model variance or establish causality.

## Results

Both requests succeeded in transport and returned the required crop dimensions.
The unmodified production appearance validator rejected both.

| Case | Rear-classified hidden pixels | Unknown hidden pixels | Result |
| --- | ---: | ---: | --- |
| Prior natural baseline | 0 | 29,120 | `ambiguous_appearance` |
| A: no foreground description | 3,285 | 25,502 | `ambiguous_appearance` |
| B: source reference alone | 17,576 | 11,544 | `ambiguous_appearance` |

All cases have 29,120 hidden pixels. A additionally classified 333 as background;
B classified none as background. Neither had source-front-classified or
semi-transparent fringe pixels. Rear-classified pixels are only intermediate
color matches, not accepted generated layers.

Visual inspection of A shows the blue circle still interrupted by a dark
vertical strip. Removing the foreground label did not reconstruct the missing
circle. B shows two orange bars and a substantially redrawn scene, not a valid
completion. A changed 53,453 source-visible return pixels; B changed all 64,117.
These returned pixels were never promoted into an accepted asset.

## Evidence and decision

Private evidence resides in
`.codex-tmp/release-v0.3.0/completion-ablation-9dL25T/`, including `scope.json`,
`calls.json` (exactly two inference calls), each arm's input/result/return,
effective wire prompt, image-reference hashes, and offline quality replay.
Both arms used the same padded source hash
`6928304b7546fe5a26d6f7e6273108ab43a10b091ee245071a6ebc8d9b942d06`.
Request and returned artifacts were exclusively created with mode 0600 in
private directories; diagnostic scripts/results remain ignored.

Neither variant provides an accepted completion. No PPTX or WPS acceptance was
attempted for these rejected diagnostic returns. Stop prompt/reference retries
at the approved budget. The next investigation should establish whether a
genuine mask-edit transport is available, or revisit the completion feature's
supported routes; do not loosen the validator to accept these outputs.
This is a diagnostic conclusion, not a production fix or release approval.
