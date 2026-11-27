import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function main() {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    fail("dependency audit must run through npm so npm_execpath is authenticated");
    return;
  }
  const auditEnvironment = { ...process.env };
  for (const key of Object.keys(auditEnvironment)) {
    if (key.toLowerCase() === "npm_config_allow_scripts") delete auditEnvironment[key];
  }
  const audit = spawnSync(process.execPath, [npmExecPath, "audit", "--json"], {
    cwd: process.cwd(),
    env: auditEnvironment,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (audit.error) throw audit.error;
  if (audit.status === 0) {
    process.stdout.write("Dependency audit passed with no known vulnerabilities.\n");
    return;
  }

  fail(audit.stdout || audit.stderr || "npm audit failed");
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
