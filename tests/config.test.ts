import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("missing DASHSCOPE_API_KEY reports the variable name", () => {
  assert.throws(
    () => loadConfig({ DASHSCOPE_WORKSPACE_ID: "workspace-123" }),
    /DASHSCOPE_API_KEY/,
  );
});

test("missing DASHSCOPE_WORKSPACE_ID reports the variable name", () => {
  assert.throws(
    () => loadConfig({ DASHSCOPE_API_KEY: "secret" }),
    /DASHSCOPE_WORKSPACE_ID/,
  );
});

test("derives Beijing API URLs from the workspace ID", () => {
  const config = loadConfig({
    DASHSCOPE_API_KEY: "secret",
    DASHSCOPE_WORKSPACE_ID: "workspace-123",
  });

  assert.equal(
    config.dashscopeApiBase,
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1",
  );
  assert.equal(
    config.dashscopeCompatibleBase,
    "https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  );
});
