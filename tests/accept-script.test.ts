import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function runScript(env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("/bin/bash", [resolve("scripts/accept-slide-07.sh")], {
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

test("acceptance script preflights both credentials before invoking npm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ppt-accept-script-"));
  const npmMarker = join(directory, "npm-was-called");
  const fakeNpm = join(directory, "npm");

  try {
    await writeFile(
      fakeNpm,
      `#!/bin/sh\nprintf called > "${npmMarker}"\n`,
      "utf8",
    );
    await chmod(fakeNpm, 0o755);

    const missingKey = await runScript({
      PATH: directory,
      DASHSCOPE_WORKSPACE_ID: "workspace-123",
    });
    assert.equal(missingKey.code, 1);
    assert.equal(missingKey.stdout, "");
    assert.equal(
      missingKey.stderr.trim(),
      "Missing required environment variables: DASHSCOPE_API_KEY",
    );

    const missingWorkspace = await runScript({
      PATH: directory,
      DASHSCOPE_API_KEY: "offline-test-key",
    });
    assert.equal(missingWorkspace.code, 1);
    assert.equal(missingWorkspace.stdout, "");
    assert.equal(
      missingWorkspace.stderr.trim(),
      "Missing required environment variables: DASHSCOPE_WORKSPACE_ID",
    );

    const missingBoth = await runScript({ PATH: directory });
    assert.equal(missingBoth.code, 1);
    assert.equal(
      missingBoth.stderr.trim(),
      "Missing required environment variables: DASHSCOPE_API_KEY, DASHSCOPE_WORKSPACE_ID",
    );
    await assert.rejects(access(npmMarker), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
