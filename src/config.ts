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
  };
}
