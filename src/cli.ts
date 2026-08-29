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

const USAGE = `Image to Editable PPTX

Usage:
  npm run cli -- analyze <slide.png|slide.jpg|slide.jpeg> --out <dir>
    [--max-region-analysis <0..8>] [--max-occlusion-completions <0..4>] [--record]
  npm run cli -- build --analysis <dir> --out <dir> [--required-text-count <n>]
  npm run cli -- build-v1 <slide.png|slide.jpg|slide.jpeg> --analysis <dir> --out <dir>
    [--required-text-count <n>]
  npm run cli -- run <slide.png|slide.jpg|slide.jpeg> --out <dir>
    [--max-region-analysis <0..8>] [--max-occlusion-completions <0..4>]
    [--required-text-count <n>] [--record]

build consumes a self-contained analysis package v2 without network access.
build-v1 is the explicit compatibility path for legacy analysis packages that
still require the original source image. Provider credentials are environment-only.`;

type AnalysisLimits = {
  maxRegionAnalysis?: number;
  maxOcclusionCompletions?: number;
};

type AnalyzeCommand = AnalysisLimits & {
  command: "analyze";
  image: string;
  out: string;
  record: boolean;
};

type BuildCommand = {
  command: "build";
  analysis: string;
  out: string;
  record: false;
  requiredTextCount?: number;
};

type BuildV1Command = {
  command: "build-v1";
  image: string;
  analysis: string;
  out: string;
  record: false;
  requiredTextCount?: number;
};

type RunCommand = AnalysisLimits & {
  command: "run";
  image: string;
  out: string;
  record: boolean;
  requiredTextCount?: number;
};

export type CliCommand =
  | AnalyzeCommand
  | BuildCommand
  | BuildV1Command
  | RunCommand;

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

function parseBoundedInteger(
  option: string,
  value: string | undefined,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!new RegExp(`^[0-${maximum}]$`).test(value)) {
    throw usageError(`${option} must be an integer from 0 through ${maximum}.`);
  }
  return Number(value);
}

function parseRequiredTextCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw usageError("--required-text-count must be a positive integer.");
  }
  return parsed;
}

export function parseCliArgs(args: readonly string[]): CliCommand {
  const command = args[0];
  if (
    command !== "analyze" &&
    command !== "build" &&
    command !== "build-v1" &&
    command !== "run"
  ) {
    throw usageError("Expected command analyze, build, build-v1, or run.");
  }

  const values = new Map<string, string>();
  const positionals: string[] = [];
  let record = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--record") {
      if (record) throw usageError("Duplicate option: --record");
      record = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (
      argument !== "--image" &&
      argument !== "--out" &&
      argument !== "--analysis" &&
      argument !== "--required-text-count" &&
      argument !== "--max-region-analysis" &&
      argument !== "--max-occlusion-completions"
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

  const out = values.get("--out");
  if (out === undefined) throw usageError("--out is required.");

  const analysis = values.get("--analysis");
  const requiredTextCount = parseRequiredTextCount(
    values.get("--required-text-count"),
  );
  const maxRegionAnalysis = parseBoundedInteger(
    "--max-region-analysis",
    values.get("--max-region-analysis"),
    8,
  );
  const maxOcclusionCompletions = parseBoundedInteger(
    "--max-occlusion-completions",
    values.get("--max-occlusion-completions"),
    4,
  );

  if (command === "build" || command === "build-v1") {
    if (analysis === undefined) throw usageError(`${command} requires --analysis.`);
    if (record) throw usageError("--record is not valid for offline build.");
    if (maxRegionAnalysis !== undefined || maxOcclusionCompletions !== undefined) {
      throw usageError("Analysis-stage limit flags are not valid for offline build.");
    }
    if (values.has("--image")) {
      throw usageError(
        command === "build"
          ? "--image is not valid for offline build; use build-v1 for a legacy package."
          : "build-v1 accepts its source image as one positional argument.",
      );
    }
    if (command === "build") {
      if (positionals.length !== 0) {
        throw usageError(
          "Offline build v2 does not accept an image; use build-v1 for a legacy package.",
        );
      }
      return {
        command,
        analysis,
        out,
        record: false,
        ...(requiredTextCount === undefined ? {} : { requiredTextCount }),
      };
    }
    if (positionals.length !== 1) {
      throw usageError("build-v1 requires exactly one positional source image.");
    }
    return {
      command,
      image: positionals[0]!,
      analysis,
      out,
      record: false,
      ...(requiredTextCount === undefined ? {} : { requiredTextCount }),
    };
  }

  if (analysis !== undefined) {
    throw usageError("--analysis is only valid for build and build-v1.");
  }
  if (command === "analyze" && requiredTextCount !== undefined) {
    throw usageError("--required-text-count is only valid for build and run.");
  }

  const imageOption = values.get("--image");
  if (positionals.length > 1 || (positionals.length === 1 && imageOption !== undefined)) {
    throw usageError("Provide only one image, either positionally or with --image.");
  }
  const image = positionals[0] ?? imageOption;
  if (image === undefined) throw usageError(`${command} requires a source image.`);

  const limits = {
    ...(maxRegionAnalysis === undefined ? {} : { maxRegionAnalysis }),
    ...(maxOcclusionCompletions === undefined
      ? {}
      : { maxOcclusionCompletions }),
  };
  if (command === "analyze") {
    return { command, image, out, record, ...limits };
  }
  return {
    command,
    image,
    out,
    record,
    ...limits,
    ...(requiredTextCount === undefined ? {} : { requiredTextCount }),
  };
}

function withConfig<T extends { config?: AppConfig }>(
  options: Omit<T, "config">,
  config: AppConfig,
): T {
  return { ...options, config } as T;
}

function applyAnalysisLimits(
  config: AppConfig,
  command: AnalysisLimits,
): AppConfig {
  return {
    ...config,
    ...(command.maxRegionAnalysis === undefined
      ? {}
      : { maxRegionAnalysis: command.maxRegionAnalysis }),
    ...(command.maxOcclusionCompletions === undefined
      ? {}
      : { maxOcclusionCompletions: command.maxOcclusionCompletions }),
  };
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
      const config = applyAnalysisLimits(loadConfig(env), command);
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
      await dependencies.build({
        analysisDir: command.analysis,
        outDir: command.out,
        ...(command.requiredTextCount === undefined
          ? {}
          : { requiredTextCount: command.requiredTextCount }),
      });
      break;
    case "build-v1":
      await dependencies.build({
        imagePath: command.image,
        analysisDir: command.analysis,
        outDir: command.out,
        ...(command.requiredTextCount === undefined
          ? {}
          : { requiredTextCount: command.requiredTextCount }),
      });
      break;
    case "run":
    {
      const config = applyAnalysisLimits(loadConfig(env), command);
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
