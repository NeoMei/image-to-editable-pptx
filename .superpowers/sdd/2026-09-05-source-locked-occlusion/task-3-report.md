# Task 3 report: source-locked artifact composition

## Status

DONE

## Implemented

- Added the private `CompletionOutcome` / `CompletionReason` coordination contract while retaining `completeOccludedCandidate()` as the compatibility wrapper.
- Added private strict diagnostic schemas for bounded outcome reasons and numeric quality metrics.
- Qualified source appearance before budget acquisition and provider invocation. The required contacts are the unique flattened endpoints of accepted evidence pairs.
- Validated provider-return geometry and metadata, then called `assessHiddenCandidate()` before the existing bridge and contour checks.
- Replaced raw-return equality enforcement with fresh source-locked composition: source-visible RGBA comes only from the immutable original crop, accepted generated support comes only from the private provider return, and all remaining pixels stay transparent.
- Added an independent final invariant check for dimensions and lengths, byte-identical source-visible pixels, disjoint visible/generated support, generated containment in hidden evidence, transparent pixels outside the support union, and continuous contour.
- Preserved source provenance against the immutable original crop, separately hashed visible/generated masks and the final image, and retained `reviewRequired: true`.
- Preserved routing terminal throws, provider timeout ownership, metadata rejection, the zero-through-four budget, and single-provider-call ownership.
- Migrated provider-path completion tests from the 9x5 evidence-only fixture to the qualified 32x24 source-locked fixture. Small geometry/contact cases remain dedicated evidence-only tests.
- Added an actual-completion semantic build integration that accepts and recomposes the artifact, preserves provenance/review state, and rejects one tampered source-visible byte even when the attacker recomputes `assetSha256`.

## TDD evidence

### RED

Command:

```text
node --import tsx --test --test-name-pattern='source-locks visible|rejects bad hidden|source appearance is unqualified' tests/occlusion-complete.test.ts
```

Relevant output before production changes:

```text
SyntaxError: The requested module '../src/occlusion/complete.js' does not provide an export named 'evaluateOccludedCandidate'
tests 1
pass 0
fail 1
```

This was the expected failure: the new source-locked outcome API and composition behavior did not exist.

The first real semantic integration also correctly failed after it created a real completion but used an unsuitable 32x24 page fixture:

```text
candidateId: rear
decision: kept_in_background
reason: recomposition_mismatch
meanAbsoluteError: 9.444444444444445
p95ChannelDelta: 190
changedPixelRatio: 0.08333333333333333
```

Systematic trace found that the 32x24 front candidate failed its own local source-visible extraction first: its selected front asset included the source blue rear pixels inside its bbox while local repair removed only the orange support, causing 20 changed pixels over its 336-pixel local comparison. The final active stage therefore contained the rear completion without the front overlay, exposing 64 blue generated pixels where the original page remained orange. Layer order itself was correct (`rear` zIndex 0, `front` zIndex 1); manually recomposing the repaired background with both ordered layers produced exact zero-error output. The earlier diagnostic accidentally retained the first repair background from the successful two-layer attempt, so it demonstrated expected layer ordering but did not identify the front stage's prior local rejection. No `fidelity/build.ts` change was warranted. The integration was moved to the established semantic fixture, where the front candidate is already a valid accepted stage.

### GREEN

Focused command:

```text
node --import tsx --test tests/occlusion-complete.test.ts tests/semantic-build.test.ts
```

Relevant final output:

```text
tests 41
pass 41
fail 0
cancelled 0
skipped 0
todo 0
```

Typecheck:

```text
npm run lint:types
> tsc -p tsconfig.json --noEmit
```

Full source suite (one final run):

```text
npm test
tests 516
pass 516
fail 0
cancelled 0
skipped 0
todo 0
```

Whitespace check:

```text
git diff --check
```

Exit status was 0 with no output.

## Files changed

- `src/occlusion/complete.ts`
- `src/occlusion/contracts.ts`
- `src/occlusion/diagnostics.ts`
- `tests/occlusion-complete.test.ts`
- `tests/semantic-build.test.ts`
- `.superpowers/sdd/2026-09-05-source-locked-occlusion/task-3-report.md`

## Self-review

- Confirmed the provider return buffer is never mutated or used as the destination buffer.
- Confirmed request and original crop hashes are independently different, while provenance always uses the original source crop hash.
- Confirmed all returned outside-hidden changes are metrics only; generated support comes solely from qualified hidden evidence.
- Confirmed source-visible equality, support disjointness/containment, transparency outside support, `reviewRequired`, terminal error propagation, and budget-before-provider behavior have direct tests.
- Added a missing-occluder-mask case discovered during self-review; it rejects before the provider is called.
- Reviewed only Task 3 files; no dependencies, live calls, remote operations, releases, or unrelated production files changed.

## Concerns

None. The semantic fixture adds one narrow background pixel column beside the rear/front contact to supply the frozen minimum independent background evidence; quality thresholds were not changed or bypassed.

## Regression fix after Task 4 integration

Task 4's concurrent full-source verification exposed a timing-sensitive test-only
failure in `rejects bad hidden content after one provider request`. The provider
stub called `sourceLockedOcclusionFixture()` inside the production-owned 100 ms
timeout. That helper generates and PNG-encodes every fixture variant, so under
full-suite load the test took 190.83 ms and the completion correctly returned
`{ status: "skipped", reason: "provider_failure" }` before quality validation.

The fixture's `retainedFront` PNG is now prepared before calling
`evaluateOccludedCandidate()`. The timed provider callback only returns that
prepared response. Production timeout behavior, the dedicated timeout test, and
the `residual_occluder` quality assertion remain unchanged.

Failure evidence from Task 4's pre-fix full suite:

```text
✖ rejects bad hidden content after one provider request (190.83ms)
actual: 'skipped'
expected: 'rejected'
tests 522
pass 521
fail 1
```

Focused verification after the fix:

```text
node --import tsx --test --test-name-pattern='rejects bad hidden content after one provider request' tests/occlusion-complete.test.ts
tests 1
pass 1
fail 0
```

Fresh full source and type verification after the fix:

```text
npm run lint:types
> tsc -p tsconfig.json --noEmit

npm test
tests 522
pass 522
fail 0
cancelled 0
skipped 0
todo 0
```

The exact-path regression commit contains only
`tests/occlusion-complete.test.ts`; this appended report is retained as local
review evidence outside that commit per the controller's scope.
