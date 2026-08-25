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
};

type Environment = Readonly<Record<string, string | undefined>>;

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
  const workspaceId = env.DASHSCOPE_WORKSPACE_ID!.trim();
  const host = `https://${workspaceId}.cn-beijing.maas.aliyuncs.com`;

  return {
    apiKey,
    workspaceId,
    dashscopeApiBase: `${host}/api/v1`,
    dashscopeCompatibleBase: `${host}/compatible-mode/v1`,
    ocrModel: "qwen3.5-ocr",
    visionModel: "qwen3-vl-plus",
    editModel: "wanx2.1-imageedit",
    requestTimeoutMs: 120_000,
    pollIntervalMs: 2_000,
  };
}
