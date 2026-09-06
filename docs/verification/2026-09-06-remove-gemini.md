# Gemini retirement verification

The user confirmed removing Gemini from OCR, scene analysis, and image-layer
completion. This supersedes the five-candidate routing described in the earlier
fallback/source-locked plans; their historical acceptance evidence is unchanged.
The decision reflects this plugin's incomplete acceptance evidence, not a claim
that Gemini can never perform image layering.

## Implemented boundary

All three operations now use `host-openai → api-openai → api-alibaba`. Gemini
API configuration, executor implementations, host discovery, and invocation
paths are removed. Old Gemini credentials and model overrides cannot activate
a route. Independent sticky cursors, terminal errors, request budgets, source
locking, and quality thresholds are unchanged. Quality rejection still does
not trigger another provider.

An old file-bridge `providers.gemini` field is ignored; all other unknown
provider keys remain invalid. Runtime calls naming the retired provider are
rejected without writing a request or sending an image. Historical v2 ledgers
may retain Gemini provenance so existing packages can still build offline;
this compatibility never enables live execution.

## Verification

- Red/green regressions reproduced and then prevented Gemini credential
  activation and selection across all three operations, including sticky reuse.
- Host regressions cover retired declarations and strict unknown-key rejection.
- Focused router/config/session/pipeline suite: 24/24 passed, including an
  actual offline rebuild from a v2 ledger containing historical Gemini entries.
- Focused adapter suite: 44/44 passed; shared authentication and image-byte
  safety cases were retained on OpenAI while Gemini-only cases were removed.
- Focused host/OpenCodex/child CLI suite: 50/50 passed.
- Review identified a missing explicit OpenCodex retirement regression. Two
  added tests now cover Gemini-only catalogs/legacy overrides and forced
  runtime Gemini calls for all three operations, with no inference traffic.
- Final `npm run verify` exited 0: 517 source tests and 517 compiled tests,
  strict types, build, dependency audit, and whitespace checks. The audit still
  accepts the two existing unreachable image-size advisories, not zero debt.
- Package dry-run succeeded and excluded private diagnostic paths and tests.
- Reference-skill scenario testing first followed the old Gemini chain; after
  the update it correctly rejected Gemini-only availability and advanced from
  unavailable OpenAI routes directly to configured Alibaba.
- Independent code review found no remaining Critical, Important, or Minor
  issues after the two OpenCodex regression tests closed its sole test gap.

The first concurrent full run caught the deliberately red unknown-provider
regression before its schema repair; it is not counted as a passing run. The
final full run above was performed after the production repair.

No live inference requests, account/configuration changes, merge, push, tag,
publication, or installed-cache changes were made. This retirement does not
resolve the remaining real generated-layer and editor acceptance gates;
release remains blocked.
