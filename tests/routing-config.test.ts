import assert from "node:assert/strict";
import test from "node:test";

import { loadRoutingConfig } from "../src/config.js";

test("routing config accepts OpenAI-only credentials without eager Alibaba config", () => {
  const config = loadRoutingConfig({ OPENAI_API_KEY: "openai-secret" });
  assert.equal(config.openai?.apiKey, "openai-secret");
  assert.equal(config.openai?.analysisModel, "gpt-4.1");
  assert.equal(config.openai?.imageModel, "gpt-image-2");
  assert.equal("gemini" in config, false);
  assert.equal(config.alibaba, undefined);
});

test("retired Gemini credentials and overrides cannot enable a provider", () => {
  const config = loadRoutingConfig({
    GOOGLE_API_KEY: "google-secret",
    GEMINI_API_KEY: "gemini-secret",
    OPENAI_ANALYSIS_MODEL: "gpt-4.1-mini",
    GEMINI_ANALYSIS_MODEL: "gemini-custom",
    GEMINI_IMAGE_MODEL: "gemini-image-custom",
  });
  assert.equal(config.openai, undefined);
  assert.equal("gemini" in config, false);
});

test("routing config includes Alibaba only when both credentials are valid", () => {
  assert.equal(loadRoutingConfig({ DASHSCOPE_API_KEY: "key" }).alibaba, undefined);
  assert.equal(loadRoutingConfig({ DASHSCOPE_WORKSPACE_ID: "workspace-123" }).alibaba, undefined);
  assert.equal(
    loadRoutingConfig({
      DASHSCOPE_API_KEY: "key", DASHSCOPE_WORKSPACE_ID: "workspace-123",
    }).alibaba?.workspaceId,
    "workspace-123",
  );
});
