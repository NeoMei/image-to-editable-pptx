export type AppConfig = {
  apiKey: string;
  workspaceId: string;
  dashscopeApiBase: string;
  dashscopeCompatibleBase: string;
  ocrModel: "qwen3.5-ocr";
  visionModel: string;
  editModel: "wanx2.1-imageedit";
  requestTimeoutMs: number;
  pollIntervalMs: number;
  maxRegionAnalysis?: number;
  maxOcclusionCompletions?: number;
};

export type RoutedProviderConfig = {
  apiKey: string;
  analysisModel: string;
  imageModel: string;
};

export type ProviderRoutingConfig = {
  openai?: RoutedProviderConfig;
  alibaba?: AppConfig;
  requestTimeoutMs: number;
  maxAttempts: number;
  maxRegionAnalysis: number;
  maxOcclusionCompletions: number;
};

type Environment = Readonly<Record<string, string | undefined>>;

const WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function createDashscopeBaseUrl(
  workspaceId: string,
  pathname: "/api/v1" | "/compatible-mode/v1",
): string {
  const expectedHostname =
    `${workspaceId}.cn-beijing.maas.aliyuncs.com`.toLowerCase();
  const expectedHref = `https://${expectedHostname}${pathname}`;
  const url = new URL(`https://${expectedHostname}${pathname}`);

  if (
    url.protocol !== "https:" ||
    url.hostname !== expectedHostname ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== pathname ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== expectedHref
  ) {
    throw new Error("Failed to construct a safe DashScope base URL");
  }

  return url.href;
}

export function loadConfig(env: Environment = process.env): AppConfig {
  const requiredVariables = [
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_WORKSPACE_ID",
  ] as const;
  const missingVariables = requiredVariables.filter(
    (variable) => !env[variable]?.trim(),
  );

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVariables.join(", ")}`,
    );
  }

  const apiKey = env.DASHSCOPE_API_KEY!.trim();
  const workspaceId = env.DASHSCOPE_WORKSPACE_ID!;

  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(
      "DASHSCOPE_WORKSPACE_ID must be a single valid DNS label",
    );
  }

  const configuredMaxRegionAnalysis = env.MAX_REGION_ANALYSIS;
  if (
    configuredMaxRegionAnalysis !== undefined &&
    !/^[0-8]$/.test(configuredMaxRegionAnalysis)
  ) {
    throw new Error("MAX_REGION_ANALYSIS must be an integer from 0 through 8");
  }

  const configuredMaxOcclusionCompletions = env.MAX_OCCLUSION_COMPLETIONS;
  if (
    configuredMaxOcclusionCompletions !== undefined &&
    !/^[0-4]$/.test(configuredMaxOcclusionCompletions)
  ) {
    throw new Error(
      "MAX_OCCLUSION_COMPLETIONS must be an integer from 0 through 4",
    );
  }

  return {
    apiKey,
    workspaceId,
    dashscopeApiBase: createDashscopeBaseUrl(workspaceId, "/api/v1"),
    dashscopeCompatibleBase: createDashscopeBaseUrl(
      workspaceId,
      "/compatible-mode/v1",
    ),
    ocrModel: "qwen3.5-ocr",
    visionModel: "qwen3-vl-plus",
    editModel: "wanx2.1-imageedit",
    requestTimeoutMs: 120_000,
    pollIntervalMs: 2_000,
    maxRegionAnalysis:
      configuredMaxRegionAnalysis === undefined
        ? 8
        : Number(configuredMaxRegionAnalysis),
    maxOcclusionCompletions:
      configuredMaxOcclusionCompletions === undefined
        ? 4
        : Number(configuredMaxOcclusionCompletions),
  };
}

function optionalCredential(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === "" ? undefined : value;
}

function loadLimit(
  env: Environment,
  name: "MAX_REGION_ANALYSIS" | "MAX_OCCLUSION_COMPLETIONS",
  maximum: 8 | 4,
): number {
  const value = env[name];
  if (value === undefined) return maximum;
  if (!new RegExp(`^[0-${maximum}]$`).test(value)) {
    throw new Error(`${name} must be an integer from 0 through ${maximum}`);
  }
  return Number(value);
}

/** Optional-credential live routing config. The legacy loadConfig remains strict. */
export function loadRoutingConfig(
  env: Environment = process.env,
): ProviderRoutingConfig {
  const openaiKey = optionalCredential(env, "OPENAI_API_KEY");
  const dashscopeKey = optionalCredential(env, "DASHSCOPE_API_KEY");
  const workspaceId = optionalCredential(env, "DASHSCOPE_WORKSPACE_ID");
  const alibaba =
    dashscopeKey !== undefined && workspaceId !== undefined
      ? loadConfig(env)
      : undefined;
  return {
    ...(openaiKey === undefined
      ? {}
      : {
          openai: {
            apiKey: openaiKey,
            analysisModel:
              optionalCredential(env, "OPENAI_ANALYSIS_MODEL") ?? "gpt-4.1",
            imageModel:
              optionalCredential(env, "OPENAI_IMAGE_MODEL") ?? "gpt-image-2",
          },
        }),
    ...(alibaba === undefined ? {} : { alibaba }),
    requestTimeoutMs: 120_000,
    maxAttempts: 2,
    maxRegionAnalysis: loadLimit(env, "MAX_REGION_ANALYSIS", 8),
    maxOcclusionCompletions: loadLimit(
      env,
      "MAX_OCCLUSION_COMPLETIONS",
      4,
    ),
  };
}
