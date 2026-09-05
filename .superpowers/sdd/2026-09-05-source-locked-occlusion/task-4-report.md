# Task 4 report: bounded completion diagnostics and offline boundary

## Status

DONE

## Implemented

- Added the strict version-1 `CompletionDiagnosticsSchema` and the fixed
  `completion-diagnostics.json` filename. Entries retain only a canonical
  zero-based plan index, bounded status/reason enums, and safe finite metrics.
  Accepted entries require metrics and forbid reasons; skipped/rejected entries
  require reasons and allow metrics. Unknown keys are rejected.
- Added an exclusive private sidecar writer using `O_EXCL`, `O_NOFOLLOW`, mode
  `0600`, file sync, and no replace-capable rename. Existing regular targets,
  symbolic links, and concurrent claims are refused without altering the
  foreign content.
- Changed `completeEligibleCandidates()` to consume
  `evaluateOccludedCandidate()` outcomes. Artifact publication and provider
  request counting are unchanged; only accepted outcomes publish artifacts.
  Diagnostics use the canonical semantic plan index rather than accepted-
  artifact numbering.
- Routed and legacy live analysis now write the validated sidecar in their
  already-owned staging directory before publishing the strict v2 ledger.
  Version-2 ledger fields and hashes remain unchanged.
- Kept the offline boundary deliberately narrow: `readAnalysisPackage()` and
  `buildSlide()` do not require, read, trust, copy, or regenerate the optional
  sidecar. A proposed reader/copy path was removed during scope review because
  the brief does not authorize sidecar republication and that path would have
  introduced an unnecessary unbounded-read/TOCTOU surface.
- Added routed integration evidence for transport success followed by local
  `residual_occluder` rejection, one completion request, no provider fallback,
  no completion artifact, retained source background, and zero build-time
  network requests.
- Added terminal completion-refusal coverage proving it aborts analysis and is
  not rewritten into a quality outcome.
- Added a genuine evaluated acceptance path using the established 320-by-200
  semantic geometry and frozen ten-source-background-sample setup. The accepted
  outcome survives analysis staging, atomic package publication, package read,
  and offline build as a composite `reviewRequired` layer. The rejected 32-by-24
  standalone front-candidate fixture was not used and no quality gate was
  relaxed.
- Added a pipeline sidecar-claim failure test. An earlier owned output remains
  byte-identical, no staging directory leaks at the target parent, the failed
  run retains evidence, and the foreign symlink target remains unchanged.
- Documented transport success, quality acceptance, conservative appearance
  scope, no quality-driven fallback, optional-sidecar trust boundary, and the
  still-separate editor acceptance gate.

## TDD evidence

### RED 1: missing diagnostics contract

Command:

```text
node --import tsx --test tests/routed-pipeline.test.ts tests/analysis-package.test.ts
```

Relevant output before production changes:

```text
SyntaxError: The requested module '../src/occlusion/diagnostics.js' does not provide an export named 'COMPLETION_DIAGNOSTICS_NAME'
tests 2
pass 0
fail 2
```

This was the expected failure: the fixed filename, strict sidecar schema, and
exclusive writer did not exist.

### RED 2: rejected out-of-scope sidecar republication experiment

A temporary assertion checked whether split offline build copied the sidecar.
It failed with `ENOENT` at the split output. Scope review determined that this
was not a product requirement: offline build must not trust or require the
sidecar. The reader/copy implementation and assertion were removed rather than
shipping a test-driven invented feature.

### GREEN

Required focused command:

```text
node --import tsx --test tests/routed-pipeline.test.ts tests/analysis-package.test.ts tests/cli.test.ts
```

Relevant final output:

```text
tests 31
pass 31
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

Full source suite, run once after focused GREEN:

```text
npm test
tests 522
pass 522
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

- `src/occlusion/diagnostics.ts`
- `src/pipeline.ts`
- `tests/routed-pipeline.test.ts`
- `tests/analysis-package.test.ts`
- `docs/host-routing.md`
- `docs/verification/2026-09-05-source-locked-occlusion.md`
- `.superpowers/sdd/2026-09-05-source-locked-occlusion/task-4-report.md`

## Self-review

- Confirmed the sidecar mapping cannot persist the accepted artifact, scene
  labels/IDs, arbitrary provider metadata, paths, URLs, or raw images.
- Confirmed safe integer bounds for sequences/counts and the physical 0-through-
  255 bound for the maximum RGB seam delta.
- Confirmed quality rejection leaves the successful transport operation intact
  and does not invoke the next provider.
- Confirmed terminal routing errors still escape `evaluateOccludedCandidate()`.
- Confirmed accepted artifact filenames and request counts retain their previous
  behavior.
- Confirmed both routed and legacy live paths publish diagnostics before the v2
  ledger, while replay v1 and offline build behavior remain unchanged.
- Confirmed exclusive target creation, foreign regular/symlink preservation,
  retained failed-run evidence, and prior-output atomicity.
- Reviewed the exact Task 4 diff only; no dependency, credential, network,
  threshold, release, installation, or unrelated source changes were made.

## Concerns

The earlier provider-return offline replay at `9ffdf74` is provisional evidence.
It reported `residual_occluder`, 28,492 residual pixels, zero generated pixels,
and zero network calls. The final private replay remains required after the
whole-branch review. No raw private replay images are recorded in public docs.

## Review fix round 1: optional accepted metrics

The review found that the persisted sidecar contract in the Task 4 brief declares
`metrics?: QualityMetrics` for every status, while the initial persisted
`CompletionDiagnosticSchema` required metrics for accepted entries. The schema
now accepts an accepted diagnostic without metrics. The separate internal
`CompletionOutcomeDiagnosticSchema` still requires metrics for a real accepted
completion outcome, and production mapping continues to persist those available
metrics.

### RED

Command:

```text
node --import tsx --test --test-name-pattern='keeps completion diagnostics bounded' tests/analysis-package.test.ts
```

Relevant output before the fix:

```text
ZodError: Invalid input: expected object, received undefined
tests 1
pass 0
fail 1
```

The expected failure was the accepted sidecar entry without `metrics` being
rejected by the persisted schema.

### GREEN

Commands:

```text
node --import tsx --test --test-name-pattern='keeps completion diagnostics bounded' tests/analysis-package.test.ts
node --import tsx --test tests/analysis-package.test.ts
npm run lint:types
```

Relevant output:

```text
focused tests 1; pass 1; fail 0
analysis-package tests 10; pass 10; fail 0
tsc -p tsconfig.json --noEmit
```

Files changed in this review fix:

- `src/occlusion/diagnostics.ts`
- `tests/analysis-package.test.ts`
- `.superpowers/sdd/2026-09-05-source-locked-occlusion/task-4-report.md`

Self-review confirmed that only the persisted accepted diagnostic changed to
optional metrics; skipped/rejected reasons, unknown-key rejection, metric bounds,
and the internal accepted-outcome requirement are unchanged.
