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

test("accepts a valid workspace DNS label and derives exact Beijing API URLs", () => {
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

  for (const [base, pathname] of [
    [config.dashscopeApiBase, "/api/v1"],
    [config.dashscopeCompatibleBase, "/compatible-mode/v1"],
  ] as const) {
    const url = new URL(base);
    assert.equal(url.protocol, "https:");
    assert.equal(
      url.hostname,
      "workspace-123.cn-beijing.maas.aliyuncs.com",
    );
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.port, "");
    assert.equal(url.pathname, pathname);
    assert.equal(url.search, "");
    assert.equal(url.hash, "");
  }
});

test("rejects workspace IDs containing URL delimiters or invalid DNS label syntax", () => {
  const invalidWorkspaceIds = [
    "",
    " ",
    "workspace/evil",
    "workspace#evil",
    "workspace?evil",
    "attacker@example",
    "workspace evil",
    " workspace",
    "workspace ",
    "workspace:8443",
    "user:pass@evil",
    "workspace.evil",
    "-workspace",
    "workspace-",
  ];

  for (const workspaceId of invalidWorkspaceIds) {
    assert.throws(
      () =>
        loadConfig({
          DASHSCOPE_API_KEY: "secret",
          DASHSCOPE_WORKSPACE_ID: workspaceId,
        }),
      /DASHSCOPE_WORKSPACE_ID/,
      workspaceId,
    );
  }
});
