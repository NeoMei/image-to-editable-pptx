# Host routing and file bridge protocol

`analyze` and `run` use the following candidate order for OCR and scene analysis:

1. `host-openai`
2. `api-openai`
3. `api-alibaba`

Completion uses `api-openai` → `api-alibaba`. ChatGPT host completion is
suspended for both automatic OpenCodex and registered-tool bridges. Its ledger
slot remains `unavailable` / `missing_candidate`, with no host transport attempt;
stale completion declarations do not enable it. When neither completion API is
configured (all attempts are `missing_candidate`), retain the safe background
rather than claiming a completed hidden layer. Configured API failures retain
the original fallback and terminal-exhaustion rules.

The operations are `ocr`, `scene`, and `completion`. Routing is serial and each
operation has its own forward-only sticky cursor. After one candidate succeeds,
the next request for that operation starts at that candidate. It may move
forward after a fallback-class failure, but it never moves backward during the
run. The cursor for another operation is independent.

Only `unavailable`, `auth_unavailable`, and `retryable_exhausted` advance to the
next candidate. `policy_refused`, `invalid_input`, `invalid_output`, and
`local_failure` are fatal and stop the run. A missing candidate is recorded as
`unavailable` / `missing_candidate`; it does not make a transport request.

Gemini is retired for all three operations. Its old API credentials and model
variables cannot enable a candidate. Historical v2 routing records remain
readable offline; they are provenance, not executable routing instructions.

## Automatic local OpenCodex host

Without `--host-bridge`, the CLI's live `analyze` and `run` commands automatically
run `ocx access endpoints --json` and query the public loopback `/v1/models`
endpoint. Existing signed-in OpenAI accounts can therefore
serve the host candidate without `OPENAI_API_KEY`. No OAuth
files, cookies, or internal tokens are read; account/provider configuration is
not changed. The local public API must accept unauthenticated local
admission; a protected or stopped endpoint is unavailable, not a reason to extract
credentials. Only literal loopback HTTP endpoints are accepted; redirects are rejected.

The default analysis route is `openai/gpt-5.6-sol`; override it using
`OPENCODEX_OPENAI_ANALYSIS_MODEL` with a model
advertised by the matching provider with vision support. Catalog entries create
candidates, not proof of access: only a real successful response and validated
operation result establish success. OpenAI uses streaming Responses (required by
ChatGPT accounts). OpenCodex advertises OCR and scene only. Completion invocations
return `unavailable` before preparing or transmitting images. Discovery no
longer queries image-routing settings. The previous host image-edit route failed
source-locked quality checks, including the independent-mask diagnostic; merely
receiving an image is not evidence of usable layer completion.

Set `IMAGE_PPT_OPENCODEX=off` to disable discovery. An explicit `--host-bridge`
takes precedence and uses only that file bridge. Library callers can explicitly
pass `await discoverOpenCodexBridge()` as `hostBridge`; library/offline builds do
not discover accounts implicitly. Each bridge invocation makes one inference
attempt. Discovery GETs are not counted as inference attempts. Official APIs and Alibaba
retain the fixed fallback order above.

## Discover registered-tool capabilities for a file bridge

The host agent must inspect its current registered tools before creating a
bridge. A model catalog entry, ordinary agent reasoning, or an image editing
tool is not proof that OCR or scene JSON is callable. Declare a provider and
operation only when a registered tool can receive the operation's local PNG
inputs and prompt and return the required result. Declare only OCR and scene.
Do not declare or service host completion, even if an image tool is registered;
the converter ignores old completion declarations.

Do not use browser or UI automation as a provider fallback. Do not read or
harvest consumer web-session cookies, `localStorage`, session storage, browser
profiles, or internal host/session tokens to manufacture API access. Host
availability for a file bridge comes only from an already registered callable tool; API
availability comes only from the documented environment variables.

The bridge directory must already exist, be owned by the current user, and have
mode `0700`. `capabilities.json` must be a regular bounded file. The copyable
OpenAI OCR-and-scene example is also shipped as
[`examples/host-capabilities.json`](examples/host-capabilities.json):

```json
{
  "version": 1,
  "providers": {
    "openai": {
      "callable": true,
      "operations": ["ocr", "scene"]
    }
  }
}
```

The only active provider key is `openai`. Active operations are `ocr` and
`scene`. The low-level version-1 schema retains `completion` for protocol
compatibility, but converter adapters and routing never schedule it.
Omit an unavailable provider instead of guessing.
`callable: false` disables all of that declaration's operations.
An old `providers.gemini` field is ignored without enabling any operations;
other unknown provider keys remain invalid. Direct Gemini invocations are
rejected without creating requests or sending image data.

Start the CLI without waiting for it to finish, then service requests while the
child is running:

```bash
npm run cli -- analyze <source.png> --out <analysis-dir> \
  --host-bridge <private-bridge-dir> \
  --max-region-analysis 0 --max-occlusion-completions 0
```

The host agent performs this service loop because only it can call the tools
registered in its current session. There is intentionally no standalone shell
bridge-servicer command that can invoke those host tools. The CLI implements
the producer/consumer file protocol; the agent implements discovery, tool calls,
and responses using the loop below.

The bridge creates `requests/request-*/` with mode `0700`, writes all input PNGs
with mode `0600`, then atomically publishes `request.json`. Treat the prompt and
images as sensitive slide content. Never upload them anywhere except the
declared registered tool, never download an arbitrary result URL, and do not
copy bridge data to a public directory.

An OCR request looks like this after publication:

```json
{
  "version": 1,
  "requestId": "123e4567-e89b-42d3-a456-426614174000",
  "provider": "openai",
  "operation": "ocr",
  "prompt": "Return JSON only as {\"lines\":[...]}. Canvas: 320 x 180.",
  "canvas": { "width": 320, "height": 180 },
  "imageFile": "input.png"
}
```

Use `imageFile` relative to that request directory. Completion additionally has
`hiddenMaskFile` and `protectedMaskFile`. Validate version, UUID, provider,
operation, canvas, and local file names before invoking a tool.

## Raw host results

The tool result remains raw until the operation adapter validates it. A bridge
success therefore means only that a host tool returned a bounded result; it is
not yet a normalized router success.

For OCR, `text` must encode exactly `{"lines":[...]}`. Every line has `text`, a
pixel `bbox` (`x`, `y`, `width`, `height`), and a four-point pixel `quad`, all
inside the request canvas. Example response:

```json
{
  "version": 1,
  "requestId": "123e4567-e89b-42d3-a456-426614174000",
  "status": "success",
  "model": "actual-tool-model",
  "text": "{\"lines\":[{\"text\":\"Q3\",\"bbox\":{\"x\":24,\"y\":18,\"width\":32,\"height\":16},\"quad\":[{\"x\":24,\"y\":18},{\"x\":56,\"y\":18},{\"x\":56,\"y\":34},{\"x\":24,\"y\":34}]}]}"
}
```

For scene analysis, `text` must encode exactly `{"nodes":[...],"relations":[...]}`.
Node `bbox` is `[x1,y1,x2,y2]` in normalized thousandths (`0..1000`) relative
to the supplied image; the adapter converts it to internal `0..1` geometry.
Return exactly one full-canvas background `[0,0,1000,1000]`. Use only the roles
and relation kinds named in the request prompt. OCR, not scene labels, owns text
content and pixel geometry.

The legacy completion response schema retains `imagePath` for one bounded local
regular PNG/JPEG file. This is protocol compatibility only, not an active
converter capability. Do not service legacy completion requests; return
`unavailable`. No completion image is promoted through the host adapter.

Here `actual-tool-model` is an explicit placeholder. In a real response, the
`model` value is the effective model identifier reported by the actual host
tool metadata, not this placeholder, an API default, or a guessed catalog label. It must match
`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`.

If the registered tool is unavailable or fails, publish a classified failure;
never synthesize OCR, scene, or image content merely to keep the pipeline moving:

```json
{
  "version": 1,
  "requestId": "123e4567-e89b-42d3-a456-426614174000",
  "status": "failure",
  "failure": {
    "status": "auth_unavailable",
    "reason": "credentials_unavailable"
  }
}
```

The closed status set is `unavailable`, `auth_unavailable`,
`retryable_exhausted`, `policy_refused`, `invalid_input`, `invalid_output`, and
`local_failure`. The closed reason set is: `unavailable`, `auth_unavailable`,
`retryable_exhausted`, `policy_refused`, `invalid_input`, `invalid_output`,
`local_failure`, `missing_candidate`, `capability_unavailable`,
`credentials_unavailable`, `bridge_timeout`, `invalid_bridge_response`,
`bridge_local_failure`, `unsafe_requests_directory`, `invalid_bridge_request`,
`mismatched_request_id`, `invalid_model_identifier`, and
`invalid_image_artifact`. It is exported as `PROVIDER_FAILURE_REASONS` in
`src/providers/routing.ts`; do not write raw tool errors or secrets into the
response. A host service normally uses the general status/reason pair for the
observed outcome (for example `policy_refused` / `policy_refused`) or
`credentials_unavailable` and `capability_unavailable` when those exact cases
apply; bridge-specific reasons are generally emitted by the CLI bridge itself.

Write each response to a private temporary file in the request directory, then
rename it to `response.json`. Keep a set of served `requestId` values so a poll
never invokes the same tool twice. Poll both the request directories and the
child status; do not block waiting for the child to exit before servicing its
requests. Continue until the child exits. If the service loop itself fails,
terminate the child and retain only explicitly owned diagnostic data.

## Optional API credentials and models

No provider key is universally required. A candidate is present only when its
complete credential set is available:

| Candidate | Credentials | Analysis default | Completion default |
| --- | --- | --- | --- |
| `api-openai` | `OPENAI_API_KEY` | `OPENAI_ANALYSIS_MODEL` or `gpt-4.1` | `OPENAI_IMAGE_MODEL` or `gpt-image-2` |
| `api-alibaba` | both `DASHSCOPE_API_KEY` and `DASHSCOPE_WORKSPACE_ID` | `qwen3.5-ocr` / `qwen3-vl-plus` | `wanx2.1-imageedit` |

Never put credentials in CLI flags, bridge files, prompts, recordings, logs, or
commits. If neither a real host capability nor a complete API credential set is
available, new `analyze`/`run` work cannot proceed. Self-contained analysis
package v2 `build` remains credential-free and network-free. Legacy package v1
continues through the explicit `build-v1` source-image compatibility command.

## Counts and acceptance boundary

`analysis-ledger.json.requests` records logical pipeline requests: at most one
OCR, one full scene request, eight regional scene requests, and four completion
requests. `routing.operations` records the candidates considered for each
logical request. `routing.transportAttempts` records actual host invocations and
individual API retry attempts. These numbers need not match.

A completion transport success means only that the selected provider returned a
validated image with the required geometry and metadata. The local completion
gate can still reject that image for conservative source-appearance, residual
occluder, seam, contour, or final-invariant reasons. Such a quality rejection
does not advance the completion routing cursor or try the next provider. A
terminal provider refusal still aborts the run and is never rewritten as a
quality rejection.

Live v2 analysis writes `completion-diagnostics.json` beside, not inside,
`analysis-ledger.json`. The version-1 sidecar contains only canonical plan
sequence numbers, bounded reason codes, and bounded numeric metrics; it contains
no scene labels, IDs, provider messages, paths, URLs, or raw images. It is
created once in the private analysis staging directory and cannot replace a
pre-existing regular file or symbolic link. The strict v2 ledger and its hashes
are unchanged. Offline `build` neither requires nor trusts the sidecar and does
not create a new quality verdict.

Automatic quality acceptance is intentionally limited to low-variation rear
surfaces whose rear, front, and local background colors are separable and whose
contacts and seams can be checked locally. Textures, gradients, glow or
transparent boundaries, same-color layers, and insufficient local evidence are
kept in the background. Even an accepted generated layer remains
`reviewRequired: true`; actual PowerPoint/WPS movement, undo, explicit
save/discard, and reopen are a later editor-acceptance boundary.

`tests/child-cli-bridge.test.ts` uses a test-only host emulator and a public CC0
geometric fixture. It drives a real child CLI through OCR and scene request
files, denies `fetch`, produces a real manifest v2 analysis package, then runs a
separate offline child build and checks the PPTX and all three QA previews. This
proves the filesystem integration without live model access; it does not prove
real OpenAI output, completion, editable text, or PowerPoint/WPS behavior.

A prior live Alibaba smoke at commit `6523547` used the same public fixture and
successfully selected `qwen3.5-ocr` and `qwen3-vl-plus`, then built v2 offline
with all provider credentials removed. That evidence does not cover OpenAI,
completion, text editability, private slides, or editor acceptance.
