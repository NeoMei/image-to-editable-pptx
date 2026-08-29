#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { measureTextSpanAcceptance } from "../src/acceptance/text-span.js";
import { SlideManifestV1Schema } from "../src/contracts.js";

const USAGE =
  "Usage: npm run measure:text-span -- --source <png> --render <png> --manifest <json> [--out <json>]";

function parseArgs(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !["--source", "--render", "--manifest", "--out"].includes(option) ||
      values.has(option)
    ) {
      throw new Error(USAGE);
    }
    values.set(option, value);
  }
  for (const required of ["--source", "--render", "--manifest"]) {
    if (!values.has(required)) throw new Error(USAGE);
  }
  return values;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [source, render, manifestText] = await Promise.all([
    readFile(args.get("--source")!),
    readFile(args.get("--render")!),
    readFile(args.get("--manifest")!, "utf8"),
  ]);
  const manifest = SlideManifestV1Schema.parse(JSON.parse(manifestText));
  const evidence = await measureTextSpanAcceptance(source, render, manifest);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const out = args.get("--out");
  if (out === undefined) {
    process.stdout.write(serialized);
  } else {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, serialized, { mode: 0o600 });
    process.stdout.write(
      `text-span ${evidence.passedCount}/${evidence.total} ${evidence.passed ? "PASS" : "FAIL"}\n`,
    );
  }
  if (!evidence.passed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
