# ChatGPT natural-path acceptance after Gemini retirement

## Scope

One real ChatGPT-host-only run used the unchanged synthetic occlusion slide
after the regional bbox prompt repair and complete Gemini retirement. It used
the default limits (8 regional analyses, 4 completions) and natural candidate
selection; neither optional stage was disabled. API credentials were not loaded,
so no OpenAI API or Alibaba requests were possible. No account configuration,
quality thresholds, model prompts, or production code were changed in this run.

Source SHA-256:
`c650badab2d774f6a4af6be52448be490d38fcfc946db2086997eb7f7cd6d1fe`.

## Observed result

- One OCR, one full-scene, and one regional-scene request succeeded using
  `gpt-5.6-sol`. The repaired regional coordinate contract passed naturally.
- One automatically selected completion request succeeded in transport using
  `gpt-image-2`, returning a valid 363-by-364 image.
- The completion prompt explicitly identified the blue rear circle and
  prohibited recreating the front object. Visual inspection of the unmodified
  return instead showed an orange rounded bar inside a dark vertical strip.
  Pixel inspection confirmed all 29,120 input hidden pixels had RGBA zero;
  the orange front pixels were not accidentally retained in the request crop.
- Production quality validation rejected `ambiguous_appearance`. An offline
  replay reproduced the metrics: 29,120 hidden pixels were all unknown, with
  zero rear-classified or source-front-classified pixels. Source qualification
  passed; this is not merely one antialiased pixel exceeding a cutoff. Zero
  `residualPixels` does not prove that the occluder was removed: the visibly
  orange return differed from the original front-color profile.
- Changes to returned pixels outside the hidden mask numbered 99,020, including
  60,130 source-visible pixels. These were not copied into an accepted asset.
- The ledger contains zero accepted completions. Offline build succeeded with
  `fetch` denied and zero network calls, producing three text elements and one
  source-visible orange-bar asset. No generated rear-object asset exists.

All three QA previews were inspected. They show the retained-background rear
object and the orange-bar asset, not a successfully generated movable circle.
The ordinary no-completion PPTX has SHA-256
`4d4bca589da1e7d9054695d58d8124e818c7e5ae56547f969a3809b622f62c24`.
This artifact does not qualify for generated-object editor acceptance; WPS
acceptance was not performed.

## Evidence and release gate

Private evidence is preserved under
`.codex-tmp/release-v0.3.0/chatgpt-acceptance-GqPX6a/`: scope, all four request and
return pairs, analysis package, ordinary offline output, summary, and the
offline quality replay/metrics. New raw diagnostic request/return files were
created exclusively with mode 0600 under a private temporary directory. They
are ignored and not distributed. Source bytes remained unchanged.

The run proves natural host routing reaches completion; it does not establish
successful hidden-layer reconstruction. Release remains **BLOCKED** for that
capability. No identical-prompt retry, threshold relaxation, synthetic layer
substitution, Gemini/Alibaba call, merge, publication, or cache update occurred.
The next step requires a scoped decision about redesigning completion or
shipping a deliberately reduced feature set, not treating this result as a pass.
