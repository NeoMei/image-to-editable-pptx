import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArgs, runCli } from "../src/cli.js";

test("parses analyze, build, and run command contracts", () => {
  assert.deepEqual(
    parseCliArgs([
      "analyze",
      "--image",
      "slide.png",
      "--out",
      "analysis",
      "--record",
    ]),
    {
      command: "analyze",
      image: "slide.png",
      out: "analysis",
      record: true,
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "build",
      "--image",
      "slide.png",
      "--analysis",
      "analysis",
      "--out",
      "output",
    ]),
    {
      command: "build",
      image: "slide.png",
      analysis: "analysis",
      out: "output",
      record: false,
    },
  );
  assert.deepEqual(
    parseCliArgs(["run", "--image", "slide.png", "--out", "output"]),
    {
      command: "run",
      image: "slide.png",
      out: "output",
      record: false,
    },
  );
});

test("rejects missing credentials before dispatching a command", async () => {
  let dispatched = false;

  await assert.rejects(
    runCli(
      ["run", "--image", "does-not-exist.png", "--out", "output"],
      {},
      {
        analyze: async () => {
          dispatched = true;
        },
        build: async () => {
          dispatched = true;
        },
        run: async () => {
          dispatched = true;
        },
      },
    ),
    /Missing required environment variables: DASHSCOPE_API_KEY, DASHSCOPE_WORKSPACE_ID/,
  );
  assert.equal(dispatched, false);
});

test("rejects incomplete and command-specific options", () => {
  assert.throws(
    () => parseCliArgs(["run", "--image", "slide.png"]),
    /Usage:/,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "analyze",
        "--image",
        "slide.png",
        "--analysis",
        "old",
        "--out",
        "analysis",
      ]),
    /--analysis is only valid for build/,
  );
});
