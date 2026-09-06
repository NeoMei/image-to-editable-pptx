# Suspend ChatGPT host completion

## Approved scope

Suspend ChatGPT host layer completion after the source-locked acceptance,
reference ablations, and independent-mask probe failed quality checks. Retain
host OCR and scene analysis. No online inference, account changes, Gemini
restoration, Alibaba requests, threshold changes, merge or release in this step.

## Implementation

- OpenCodex advertises `completion: false` and rejects direct completion before
  preparing images or sending a request. Its obsolete edit transport is removed.
- Host operation adapters omit completion even when an old bridge advertises it.
- The converter routing session excludes host completion even through an injected
  adapter factory. OCR and scene retain their independent host-first cursors.
- Completion uses OpenAI API then Alibaba API. The historical host ledger slot
  is `unavailable` / `missing_candidate`, with no host transport attempt.
- When every completion candidate is missing, the optional stage records a
  skipped `provider_failure` and preserves the safe background. Configured API
  failures, terminal exhaustion, policy refusal, and quality rejection keep
  their distinct existing behavior. No quality rejection causes extra fallback.

The low-level version-1 file protocol retains legacy completion fields and
transport validation for compatibility. They are not scheduled by converter
adapters/routing, and the shipped agent instructions prohibit servicing them.

## Validation

Five new barrier/routing tests failed before implementation and passed after it.
A host-only occlusion integration test first reproduced terminal exhaustion with
no APIs, then verified successful analysis/offline PPTX construction, unchanged
rear-object background pixels, no completed assets, and zero API requests.

The four previous host-completion integration scenarios now exercise the real
OpenAI API adapter with local mocked multipart transport: accepted completion,
quality rejection, terminal refusal, and atomic diagnostic-publication failure.
Configured-API exhaustion has a separate regression test and remains terminal.
Obsolete host edit/output tests were retired; generic file-protocol validation
and API completion validation remain covered.

Fresh source and compiled suites each contain 518 passing tests. Strict types,
compilation, and `git diff --check` pass. Dependency audit retains the two known
unreachable image-size advisory exceptions, due for review on 2026-10-03.
The dry-run package has 54 entries with no tests or private diagnostic directory.

Skill application testing first showed the old guide would attempt host
completion without API keys. The updated guide instead keeps OCR/scene on the
host, skips completion, refuses stale completion declarations, and preserves
fatal/exhausted API semantics. Independent review found no Critical, Important,
or Minor issues with this bounded change.

## Status

Local behavior change verified, not published. API mocks do not establish live
OpenAI/Alibaba completion quality or generated-layer PowerPoint/WPS acceptance.
No release readiness claim follows from this suspension.
