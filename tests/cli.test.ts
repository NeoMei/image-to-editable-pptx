import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parseCliArgs, runCli } from "../src/cli.js";

const LIVE_ENV = {
  DASHSCOPE_API_KEY: "test-only-secret",
  DASHSCOPE_WORKSPACE_ID: "workspace-123",
};

test("parses promoted v2 commands without asking build for the source image again", () => {
  assert.deepEqual(
    parseCliArgs([
      "analyze", "slide.jpeg", "--out", "analysis",
      "--max-region-analysis", "0",
      "--max-occlusion-completions", "4",
      "--record",
    ]),
    {
      command: "analyze", image: "slide.jpeg", out: "analysis", record: true,
      maxRegionAnalysis: 0, maxOcclusionCompletions: 4,
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "build", "--analysis", "analysis", "--out", "output",
      "--required-text-count", "10",
    ]),
    {
      command: "build", analysis: "analysis", out: "output", record: false,
      requiredTextCount: 10,
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "run", "slide.png", "--out", "output",
      "--max-region-analysis", "8",
      "--max-occlusion-completions", "0",
    ]),
    {
      command: "run", image: "slide.png", out: "output", record: false,
      maxRegionAnalysis: 8, maxOcclusionCompletions: 0,
    },
  );
});

test("keeps the source-taking offline path explicitly named as v1 compatibility", () => {
  assert.deepEqual(
    parseCliArgs([
      "build-v1", "slide.png", "--analysis", "legacy-analysis",
      "--out", "legacy-output",
    ]),
    {
      command: "build-v1", image: "slide.png", analysis: "legacy-analysis",
      out: "legacy-output", record: false,
    },
  );
});

test("dispatches offline v2 build without an image or live credentials", async () => {
  let received: unknown;
  await runCli(
    ["build", "--analysis", "analysis", "--out", "output", "--required-text-count", "10"],
    {},
    {
      analyze: async () => assert.fail("analyze must not be dispatched"),
      run: async () => assert.fail("run must not be dispatched"),
      build: async (options) => { received = options; },
    },
  );

  assert.deepEqual(received, {
    analysisDir: "analysis", outDir: "output", requiredTextCount: 10,
  });
});

test("dispatches v1 compatibility build with its required source image", async () => {
  let received: unknown;
  await runCli(
    ["build-v1", "slide.png", "--analysis", "legacy-analysis", "--out", "output"],
    {},
    {
      analyze: async () => assert.fail("analyze must not be dispatched"),
      run: async () => assert.fail("run must not be dispatched"),
      build: async (options) => { received = options; },
    },
  );

  assert.deepEqual(received, {
    imagePath: "slide.png", analysisDir: "legacy-analysis", outDir: "output",
  });
});

test("uses bounded default analysis budgets when flags are omitted", async () => {
  let received: unknown;
  await runCli(
    ["analyze", "slide.jpg", "--out", "analysis"],
    LIVE_ENV,
    {
      build: async () => assert.fail("build must not be dispatched"),
      run: async () => assert.fail("run must not be dispatched"),
      analyze: async (options) => { received = options.config; },
    },
  );

  const config = received as { maxRegionAnalysis: number; maxOcclusionCompletions: number };
  assert.deepEqual(
    {
      maxRegionAnalysis: config.maxRegionAnalysis,
      maxOcclusionCompletions: config.maxOcclusionCompletions,
    },
    { maxRegionAnalysis: 8, maxOcclusionCompletions: 4 },
  );
});

test("zero flags disable both optional network analysis stages", async () => {
  let received: unknown;
  await runCli(
    [
      "run", "slide.png", "--out", "output",
      "--max-region-analysis", "0",
      "--max-occlusion-completions", "0",
    ],
    LIVE_ENV,
    {
      analyze: async () => assert.fail("analyze must not be dispatched"),
      build: async () => assert.fail("build must not be dispatched"),
      run: async (options) => { received = options.config; },
    },
  );

  const config = received as { maxRegionAnalysis: number; maxOcclusionCompletions: number };
  assert.deepEqual(
    {
      maxRegionAnalysis: config.maxRegionAnalysis,
      maxOcclusionCompletions: config.maxOcclusionCompletions,
    },
    { maxRegionAnalysis: 0, maxOcclusionCompletions: 0 },
  );
});

test("accepts only strict integer analysis budgets inside their finite ranges", () => {
  for (const [flag, validMaximum, invalidValues] of [
    ["--max-region-analysis", "8", ["-1", "9", "1.5", "01", "unlimited"]],
    ["--max-occlusion-completions", "4", ["-1", "5", "1.5", "01", "unlimited"]],
  ] as const) {
    assert.doesNotThrow(() =>
      parseCliArgs(["run", "slide.png", "--out", "output", flag, validMaximum]),
    );
    for (const value of invalidValues) {
      assert.throws(
        () => parseCliArgs(["run", "slide.png", "--out", "output", flag, value]),
        /integer.*(?:0.*8|0.*4)|(?:0.*8|0.*4).*integer/i,
        `${flag}=${value}`,
      );
    }
  }
});

test("rejects all analysis and network-stage flags on offline build", () => {
  for (const args of [
    ["--max-region-analysis", "1"],
    ["--max-occlusion-completions", "1"],
    ["--record"],
    ["--image", "slide.png"],
  ]) {
    assert.throws(
      () => parseCliArgs([
        "build", "--analysis", "analysis", "--out", "output", ...args,
      ]),
      /not valid for (?:offline )?build|Unknown option/i,
    );
  }
});

test("never accepts provider credentials or an unlimited mode on the command line", () => {
  for (const args of [
    ["--api-key", "secret"],
    ["--workspace-id", "workspace-123"],
    ["--dashscope-api-key", "secret"],
    ["--max-region-analysis", "unlimited"],
    ["--max-occlusion-completions", "unlimited"],
  ]) {
    assert.throws(
      () => parseCliArgs(["analyze", "slide.png", "--out", "analysis", ...args]),
      /Unknown option|integer/i,
    );
  }
});

test("unknown option errors never echo space-separated or equals-form values", () => {
  const sentinel = "SENTINEL_DO_NOT_ECHO_4ef297";
  const cases = [
    ["--provider-token", sentinel],
    [`--provider-secret=${sentinel}`],
  ];

  for (const credentialLikeArgs of cases) {
    assert.throws(
      () =>
        parseCliArgs([
          "analyze",
          "slide.png",
          "--out",
          "analysis",
          ...credentialLikeArgs,
        ]),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Unknown option: --provider-(?:token|secret)/);
        assert.doesNotMatch(error.message, new RegExp(sentinel));
        return true;
      },
    );

    const processResult = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "analyze",
        "slide.png",
        "--out",
        "analysis",
        ...credentialLikeArgs,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(processResult.status, 0);
    assert.equal(processResult.stdout, "");
    assert.doesNotMatch(processResult.stderr, new RegExp(sentinel));
    assert.match(
      processResult.stderr,
      /Unknown option: --provider-(?:token|secret)/,
    );
  }
});

test("usage advertises PNG and JPEG inputs and the v2 offline boundary", () => {
  assert.throws(
    () => parseCliArgs([]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\.png/);
      assert.match(error.message, /\.jpe?g/);
      assert.match(error.message, /build --analysis <dir> --out <dir>/);
      assert.match(error.message, /build-v1/);
      return true;
    },
  );
});

test("rejects missing credentials before dispatching a network command", async () => {
  let dispatched = false;
  await assert.rejects(
    runCli(
      ["run", "does-not-exist.png", "--out", "output"],
      {},
      {
        analyze: async () => { dispatched = true; },
        build: async () => { dispatched = true; },
        run: async () => { dispatched = true; },
      },
    ),
    /Missing required environment variables: DASHSCOPE_API_KEY, DASHSCOPE_WORKSPACE_ID/,
  );
  assert.equal(dispatched, false);
});

test("keeps --image as a compatibility alias for existing analyze and run scripts", () => {
  assert.deepEqual(
    parseCliArgs(["run", "--image", "slide.png", "--out", "output"]),
    { command: "run", image: "slide.png", out: "output", record: false },
  );
  assert.throws(
    () => parseCliArgs([
      "run", "slide.png", "--image", "other.png", "--out", "output",
    ]),
    /only one image|Duplicate/i,
  );
});

test("rejects incomplete and command-specific options", () => {
  assert.throws(() => parseCliArgs(["run", "slide.png"]), /Usage:/);
  assert.throws(
    () => parseCliArgs([
      "analyze", "slide.png", "--analysis", "old", "--out", "analysis",
    ]),
    /--analysis is only valid for build/,
  );
  assert.throws(
    () => parseCliArgs([
      "run", "slide.png", "--out", "output", "--required-text-count", "0",
    ]),
    /positive integer/,
  );
  assert.throws(
    () => parseCliArgs([
      "analyze", "slide.png", "--out", "analysis", "--required-text-count", "10",
    ]),
    /only valid for build and run/,
  );
});
