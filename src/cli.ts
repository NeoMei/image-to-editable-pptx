#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { loadConfig, type AppConfig } from "./config.js";
import {
  analyzeSlide,
  buildSlide,
  runPipeline,
  type AnalyzeOptions,
  type BuildOptions,
  type RunPipelineOptions,
} from "./pipeline.js";

const USAGE = `Usage:
  npm run cli -- analyze --image <png> --out <dir> [--record]
  npm run cli -- build --image <png> --analysis <dir> --out <dir> [--required-text-count <n>]
  npm run cli -- run --image <png> --out <dir> [--required-text-count <n>] [--record]`;

type AnalyzeCommand = {
  command: "analyze";
  image: string;
  out: string;
  record: boolean;
};

type BuildCommand = {
  command: "build";
  image: string;
  analysis: string;
  out: string;
  record: false;
  requiredTextCount?: number;
};

type RunCommand = {
  command: "run";
  image: string;
  out: string;
  record: boolean;
  requiredTextCount?: number;
};

export type CliCommand = AnalyzeCommand | BuildCommand | RunCommand;

type CliDependencies = {
  analyze(options: AnalyzeOptions): Promise<unknown>;
  build(options: BuildOptions): Promise<unknown>;
  run(options: RunPipelineOptions): Promise<unknown>;
};

const defaultDependencies: CliDependencies = {
  analyze: analyzeSlide,
  build: buildSlide,
  run: runPipeline,
};

function usageError(message: string): Error {
  return new Error(`${message}\n\n${USAGE}`);
}

export function parseCliArgs(args: readonly string[]): CliCommand {
  const command = args[0];
  if (command !== "analyze" && command !== "build" && command !== "run") {
    throw usageError("Expected command analyze, build, or run.");
  }

  const values = new Map<string, string>();
  let record = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--record") {
      if (record) throw usageError("Duplicate option: --record");
      record = true;
      continue;
    }
    if (
      argument !== "--image" &&
      argument !== "--out" &&
      argument !== "--analysis" &&
      argument !== "--required-text-count"
    ) {
      throw usageError(`Unknown option: ${argument}`);
    }
    if (values.has(argument)) {
      throw usageError(`Duplicate option: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Option ${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const image = values.get("--image");
  const out = values.get("--out");
  if (image === undefined || out === undefined) {
    throw usageError("Both --image and --out are required.");
  }

  const analysis = values.get("--analysis");
  const requiredTextCountValue = values.get("--required-text-count");
  const requiredTextCount = requiredTextCountValue === undefined
    ? undefined
    : Number(requiredTextCountValue);
  if (
    requiredTextCount !== undefined &&
    (!Number.isSafeInteger(requiredTextCount) || requiredTextCount <= 0)
  ) {
    throw usageError("--required-text-count must be a positive integer.");
  }
  if (command === "analyze" && requiredTextCount !== undefined) {
    throw usageError("--required-text-count is only valid for build and run.");
  }
  if (command === "build") {
    if (analysis === undefined) {
      throw usageError("Build requires --analysis.");
    }
    if (record) throw usageError("--record is not valid for build.");
    return {
      command,
      image,
      analysis,
      out,
      record: false,
      ...(requiredTextCount === undefined ? {} : { requiredTextCount }),
    };
  }
  if (analysis !== undefined) {
    throw usageError("--analysis is only valid for build.");
  }
  return {
    command,
    image,
    out,
    record,
    ...(requiredTextCount === undefined ? {} : { requiredTextCount }),
  };
}

function withConfig<T extends { config?: AppConfig }>(
  options: Omit<T, "config">,
  config: AppConfig,
): T {
  return { ...options, config } as T;
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: CliDependencies = defaultDependencies,
): Promise<void> {
  const command = parseCliArgs(args);
  switch (command.command) {
    case "analyze":
    {
      const config = loadConfig(env);
      await dependencies.analyze(
        withConfig<AnalyzeOptions>(
          {
            imagePath: command.image,
            outDir: command.out,
            record: command.record,
          },
          config,
        ),
      );
      break;
    }
    case "build":
      await dependencies.build(
        {
          imagePath: command.image,
          analysisDir: command.analysis,
          outDir: command.out,
          ...(command.requiredTextCount === undefined
            ? {}
            : { requiredTextCount: command.requiredTextCount }),
        },
      );
      break;
    case "run":
    {
      const config = loadConfig(env);
      await dependencies.run(
        withConfig<RunPipelineOptions>(
          {
            imagePath: command.image,
            outDir: command.out,
            record: command.record,
            ...(command.requiredTextCount === undefined
              ? {}
              : { requiredTextCount: command.requiredTextCount }),
          },
          config,
        ),
      );
      break;
    }
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  pathToFileURL(entryPath).href === import.meta.url
) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
