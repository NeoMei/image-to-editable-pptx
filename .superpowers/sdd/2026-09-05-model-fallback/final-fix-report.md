# Final review fix report

Status: DONE

Base: `5f03152d43c918c196ce6754e6a396b675719175`

## Scope implemented

- Alibaba scene adapter failures now classify the OpenAI-compatible SDK's structured HTTP `status` before consulting bounded legacy message patterns. HTTP 401/403 map to `auth_unavailable`; HTTP 404 and structured `model_not_found` map to `unavailable`; HTTP 408/409/429/5xx, SDK connection/timeout failures, and bounded transport message compatibility map to `retryable_exhausted`. Existing `ProviderFailure` values retain first precedence, so typed refusal and local-observer failures are unchanged.
- Gemini policy refusal detection now uses one centralized documented finish-reason set: `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, and `ESCALATION`. Prompt-level `blockReason` behavior is retained. Non-policy outcomes including `LANGUAGE`, `OTHER`, `IMAGE_OTHER`, and `NO_IMAGE` remain `invalid_output`, not refusals.
- Host executors are now created only for operations declared by each bridge provider's capability manifest. Missing capabilities remain ordered router candidates with safe `missing_candidate` ledger status, but cause neither bridge invocation nor transport telemetry. Declared host operations are still counted once. Router ordering, per-operation sticky state, and global serialization are unchanged.

## Official Gemini reference

Verified on 2026-09-05 against:

- https://ai.google.dev/api/generate-content#FinishReason

The official `FinishReason` enumeration distinguishes content filtering reasons from ordinary failures and generation outcomes. In particular, `ESCALATION` is documented as filtering by an escalation rule, while `LANGUAGE`, `OTHER`, `IMAGE_OTHER`, and `NO_IMAGE` are not content-policy refusals.

## TDD evidence

### Initial RED

Command:

```text
node --import tsx --test tests/provider-adapters.test.ts tests/provider-routing.test.ts
```

Result: exit 1; `22` tests, `19` passed, `3` failed.

Expected failing evidence:

```text
Gemini documented content-filter finish reasons are fatal across OCR, scene, and completion
actual: invalid_output
expected: policy_refused

Alibaba scene classifies OpenAI-compatible SDK HTTP failures by structured status
HTTP 401 actual: invalid_output
expected: auth_unavailable

partial host capabilities count transport only for declared operations
actual selected candidate: host-openai
expected selected candidate: host-gemini
```

### Additional bounded RED from self-review

Command:

```text
node --import tsx --test --test-name-pattern='Alibaba scene classifies OpenAI-compatible SDK HTTP failures' tests/provider-adapters.test.ts
```

Result: exit 1; `1` test, `0` passed, `1` failed.

Expected failing evidence:

```text
HTTP 400 with structured code model_not_found
actual: invalid_input
expected: unavailable
```

### Focused GREEN

Command:

```text
node --import tsx --test tests/provider-adapters.test.ts tests/provider-routing.test.ts
```

Result: exit 0; `23` tests, `23` passed, `0` failed.

Follow-up checks:

```text
npm run lint:types
git diff --check
```

Both exited 0 with no diagnostics.

## Full repository verification

Run exactly once after all focused tests were green:

```text
npm run verify
```

Result: exit 0.

Complete stage summary:

```text
npm test
tests 425; pass 425; fail 0

npm run lint:types
exit 0; no diagnostics

npm run build
exit 0

npm run test:compiled
tests 425; pass 425; fail 0

npm run audit:dependencies
Dependency audit accepted two unreachable image-size advisories; no patched release exists. Review by 2026-10-03.

git diff --check
exit 0; no output
```

## Files changed

- `src/providers/provider-adapters.ts`
- `tests/provider-adapters.test.ts`
- `tests/provider-routing.test.ts`
- `.superpowers/sdd/2026-09-05-model-fallback/final-fix-report.md`

## Self-review and limitations

- Reviewed the final diff against all three findings. No routing candidate was reordered, no cursor/serialization code changed, and no interface or persisted ledger schema changed.
- Tests use mocked public HTTP/bridge boundaries and the real provider adapter/session paths. No live provider calls, private inputs, credentials, or installed plugin changes were used.
- Provider adapters retain their current retry contracts. The Qwen scene SDK is explicitly configured with `maxRetries: 0`; this wave classifies its exhausted single transport attempt for outer fallback and does not add a second retry layer.
- The guarded dependency audit continues to accept the two pre-existing unreachable `image-size` advisories. This wave neither changes nor suppresses that existing policy.
