import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeHttpResponseBody } from "../src/providers/response-observer.js";

test("redacts opaque sensitive aliases and provider headers from invalid JSON", () => {
  const canaries = [
    "opaque-api-key-1041",
    "opaque-access-token-2052",
    "opaque-secret-3063",
    "opaque-acs-signature-4074",
    "opaque-oss-token-5085",
    "opaque-client-secret-6096",
  ];
  const body = [
    `"api_key":"${canaries[0]}"`,
    `"accessToken":"${canaries[1]}"`,
    `"Secret":"${canaries[2]}"`,
    `x-acs-signature=${canaries[3]}`,
    `x-oss-security-token:${canaries[4]}`,
    `'client secret'='${canaries[5]}'`,
    "tokenCount=12",
    "apiKeyStatus=ok",
    "secretSauce=recipe",
    "monkey=banana",
    "not-json-tail",
  ].join(" ");

  const recording = sanitizeHttpResponseBody(body, "unrelated-configured-key");

  assert.doesNotMatch(recording.body, new RegExp(canaries.join("|"), "i"));
  assert.match(recording.body, /tokenCount=12/);
  assert.match(recording.body, /apiKeyStatus=ok/);
  assert.match(recording.body, /secretSauce=recipe/);
  assert.match(recording.body, /monkey=banana/);
  assert.match(recording.body, /not-json-tail/);
});

test("redacts quoted sensitive values containing spaces", () => {
  const body = [
    '"secret":"opaque phrase canary 7107"',
    '"client_secret":"another opaque phrase 8218"',
    '"x-acs-signature":"signed phrase 9329"',
    '"summary":"ordinary phrase remains"',
  ].join(" ");

  const recording = sanitizeHttpResponseBody(body, "unrelated-configured-key");

  assert.doesNotMatch(
    recording.body,
    /opaque phrase canary|another opaque phrase|signed phrase/i,
  );
  assert.match(recording.body, /ordinary phrase remains/);
});
