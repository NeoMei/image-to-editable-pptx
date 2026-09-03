import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const REVIEW_DEADLINE = "2026-10-03";
const ALLOWED_ADVISORIES = new Map([
  [1138808, "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr"],
  [1138809, "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq"],
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function pptxGenUsesImageSize() {
  const directory = join(process.cwd(), "node_modules", "pptxgenjs", "dist");
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if ((await readFile(join(entry.parentPath, entry.name), "utf8")).includes("image-size")) return true;
  }
  return false;
}

async function main() {
  if (new Date(`${REVIEW_DEADLINE}T00:00:00Z`) <= new Date()) {
    fail(`image-size audit exception expired on ${REVIEW_DEADLINE}; reassess upstream releases`);
    return;
  }
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

  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    fail(`npm audit did not return valid JSON\n${audit.stderr}`);
    return;
  }
  const vulnerabilities = report?.vulnerabilities ?? {};
  const imageSizeFindings = vulnerabilities["image-size"]?.via;
  if (
    Object.keys(vulnerabilities).sort().join(",") !== "image-size,pptxgenjs"
    || !Array.isArray(imageSizeFindings)
    || imageSizeFindings.length !== ALLOWED_ADVISORIES.size
    || imageSizeFindings.some((finding) =>
      typeof finding !== "object"
      || ALLOWED_ADVISORIES.get(finding.source) !== finding.url
      || finding.severity !== "high")
    || vulnerabilities.pptxgenjs?.via?.join(",") !== "image-size"
    || report.metadata?.vulnerabilities?.total !== 2
  ) {
    fail(audit.stdout);
    return;
  }

  const lock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));
  if (
    lock.packages?.["node_modules/pptxgenjs"]?.version !== "4.0.1"
    || lock.packages?.["node_modules/image-size"]?.version !== "1.2.1"
    || await pptxGenUsesImageSize()
  ) {
    fail("image-size audit exception is no longer proven unreachable");
    return;
  }
  process.stdout.write(
    `Dependency audit accepted two unreachable image-size advisories; no patched release exists. Review by ${REVIEW_DEADLINE}.\n`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
