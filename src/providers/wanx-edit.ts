import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { OcclusionCompletionProvider } from "../occlusion/contracts.js";

const WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const DASHSCOPE_RESULT_HOST_PATTERN =
  /^dashscope-result-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.oss-cn-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.aliyuncs\.com$/i;
const DASHSCOPE_OBSERVED_RESULT_HOSTS = new Set([
  "dashscope-5859.oss-cn-wulanchabu-acdr-1.aliyuncs.com",
]);

const INPAINT_PROMPT =
  "移除白色遮罩区域中的文字、图标、线条和面板边框，延续周围米白色纸张纹理与自然阴影，不添加任何新文字、符号、物体或装饰。";

function completionPrompt(semanticContext: readonly string[]): string {
  const context = semanticContext.join("\n");
  return [
    "Complete only the missing rear contour inside the white hidden-region mask.",
    "Preserve every visible pixel outside the mask exactly and do not add text or unrelated objects.",
    context,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

const SubmissionResponseSchema = z.object({
  output: z.object({
    task_id: z.string().min(1),
  }),
});

const TaskResponseSchema = z.object({
  output: z.object({
    task_id: z.string().min(1),
    task_status: z.string().min(1),
    code: z.string().optional(),
    message: z.string().optional(),
    results: z
      .array(
        z.object({
          url: z.string().optional(),
          code: z.string().optional(),
          message: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

function requireSafeWanxBase(config: AppConfig): string {
  if (!WORKSPACE_ID_PATTERN.test(config.workspaceId)) {
    throw new Error("Expected a safe Alibaba China Wanx base URL");
  }

  const expectedHostname =
    `${config.workspaceId}.cn-beijing.maas.aliyuncs.com`.toLowerCase();
  const expectedHref = `https://${expectedHostname}/api/v1`;

  let url: URL;
  try {
    url = new URL(config.dashscopeApiBase);
  } catch {
    throw new Error("Expected a safe Alibaba China Wanx base URL");
  }

  if (
    url.href !== expectedHref ||
    url.protocol !== "https:" ||
    url.hostname !== expectedHostname ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/api/v1" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Expected a safe Alibaba China Wanx base URL");
  }

  return expectedHref;
}

function requireSafeResultUrl(candidate: string): string {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Expected a safe DashScope OSS result URL");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    (!DASHSCOPE_RESULT_HOST_PATTERN.test(url.hostname) &&
      !DASHSCOPE_OBSERVED_RESULT_HOSTS.has(url.hostname))
  ) {
    throw new Error("Expected a safe DashScope OSS result URL");
  }

  return url.href;
}

export type WanxTiming = {
  now(): number;
  createTimeoutSignal(milliseconds: number): AbortSignal;
  sleep(milliseconds: number): Promise<void>;
};

const defaultWanxTiming: WanxTiming = {
  now: () => Date.now(),
  createTimeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function timeoutSignal(deadline: number, timing: WanxTiming): AbortSignal {
  const remainingMs = deadline - timing.now();
  if (remainingMs <= 0) {
    throw new Error("Wanx request timed out");
  }

  return timing.createTimeoutSignal(Math.max(1, Math.ceil(remainingMs)));
}

function errorDetails(code?: string, message?: string): string {
  return [code, message].filter(Boolean).join(": ");
}

function taskError(taskId: string, message: string, cause?: unknown): Error {
  return cause === undefined
    ? new Error(`Wanx task ${taskId} ${message}`)
    : new Error(`Wanx task ${taskId} ${message}`, { cause });
}

function taskTimeoutSignal(
  deadline: number,
  taskId: string,
  timing: WanxTiming,
): AbortSignal {
  try {
    return timeoutSignal(deadline, timing);
  } catch (error) {
    throw taskError(taskId, "timed out", error);
  }
}

function isConfiguredDeadlineTimeout(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return (
    signal.aborted &&
    typeof reason === "object" &&
    reason !== null &&
    "name" in reason &&
    reason.name === "TimeoutError"
  );
}

async function runMaskedEdit(
  source: Buffer,
  mask: Buffer,
  config: AppConfig,
  prompt: string,
  timing: WanxTiming,
): Promise<{
  image: Buffer;
  taskId: string;
  taskStatus: "SUCCEEDED";
}> {
  const baseUrl = requireSafeWanxBase(config);
  const deadline = timing.now() + config.requestTimeoutMs;
  const submission = await fetch(
    `${baseUrl}/services/aigc/image2image/image-synthesis`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: config.editModel,
        input: {
          function: "description_edit_with_mask",
          prompt,
          base_image_url: `data:image/png;base64,${source.toString("base64")}`,
          mask_image_url: `data:image/png;base64,${mask.toString("base64")}`,
        },
        parameters: { n: 1 },
      }),
      signal: timeoutSignal(deadline, timing),
      redirect: "error",
    },
  );

  if (!submission.ok) {
    throw new Error(
      `Wanx submission failed with status ${submission.status}`,
    );
  }

  let taskId: string;
  try {
    taskId = SubmissionResponseSchema.parse(await submission.json()).output
      .task_id;
  } catch (error) {
    throw new Error("Invalid Wanx submission response", { cause: error });
  }

  const pollUrl = `${baseUrl}/tasks/${encodeURIComponent(taskId)}`;

  while (true) {
    if (timing.now() >= deadline) {
      throw taskError(taskId, "timed out");
    }

    const pollSignal = taskTimeoutSignal(deadline, taskId, timing);
    let response: Response;
    try {
      response = await fetch(pollUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: pollSignal,
        redirect: "error",
      });
    } catch (error) {
      if (isConfiguredDeadlineTimeout(pollSignal)) {
        throw taskError(taskId, "timed out", error);
      }
      throw taskError(taskId, "poll failed", error);
    }

    if (!response.ok) {
      throw taskError(taskId, `poll failed with status ${response.status}`);
    }

    let task: z.infer<typeof TaskResponseSchema>["output"];
    try {
      task = TaskResponseSchema.parse(await response.json()).output;
    } catch (error) {
      if (isConfiguredDeadlineTimeout(pollSignal)) {
        throw taskError(taskId, "timed out", error);
      }
      throw taskError(taskId, "returned an invalid poll response", error);
    }

    if (task.task_id !== taskId) {
      throw taskError(
        taskId,
        `returned mismatched task_id ${task.task_id}`,
      );
    }

    if (task.task_status === "SUCCEEDED") {
      const resultUrl = task.results?.find((result) => result.url)?.url;
      if (!resultUrl) {
        const details = task.results
          ?.map((result) => errorDetails(result.code, result.message))
          .filter(Boolean)
          .join("; ");
        throw taskError(
          taskId,
          `succeeded without a downloadable result${details ? `: ${details}` : ""}`,
        );
      }

      let safeResultUrl: string;
      try {
        safeResultUrl = requireSafeResultUrl(resultUrl);
      } catch (error) {
        throw taskError(
          taskId,
          "returned an unsafe result URL; expected a safe DashScope OSS result URL",
          error,
        );
      }

      const downloadSignal = taskTimeoutSignal(deadline, taskId, timing);
      let download: Response;
      try {
        download = await fetch(safeResultUrl, {
          method: "GET",
          headers: {},
          signal: downloadSignal,
          redirect: "error",
        });
      } catch (error) {
        if (isConfiguredDeadlineTimeout(downloadSignal)) {
          throw taskError(taskId, "timed out", error);
        }
        throw taskError(taskId, "result download failed", error);
      }

      if (!download.ok) {
        throw taskError(
          taskId,
          `result download failed with status ${download.status}`,
        );
      }

      try {
        return {
          image: Buffer.from(await download.arrayBuffer()),
          taskId,
          taskStatus: "SUCCEEDED",
        };
      } catch (error) {
        if (isConfiguredDeadlineTimeout(downloadSignal)) {
          throw taskError(taskId, "timed out", error);
        }
        throw taskError(taskId, "result download could not be read", error);
      }
    }

    if (task.task_status !== "PENDING" && task.task_status !== "RUNNING") {
      const details = errorDetails(task.code, task.message);
      throw taskError(
        taskId,
        `failed with status ${task.task_status}${details ? `: ${details}` : ""}`,
      );
    }

    const remainingMs = deadline - timing.now();
    if (remainingMs <= 0) {
      throw taskError(taskId, "timed out");
    }
    await timing.sleep(Math.min(config.pollIntervalMs, remainingMs));
  }
}

export async function inpaintBackground(
  source: Buffer,
  mask: Buffer,
  config: AppConfig,
  timing: WanxTiming = defaultWanxTiming,
): Promise<{ image: Buffer; taskId: string }> {
  const { image, taskId } = await runMaskedEdit(
    source,
    mask,
    config,
    INPAINT_PROMPT,
    timing,
  );
  return { image, taskId };
}

export function createWanxOcclusionCompletionProvider(
  config: AppConfig,
  timing: WanxTiming = defaultWanxTiming,
): OcclusionCompletionProvider {
  return {
    async complete(request) {
      const result = await runMaskedEdit(
        request.crop,
        request.hiddenMask,
        config,
        completionPrompt(request.semanticContext),
        timing,
      );
      return {
        image: result.image,
        modelId: config.editModel,
        taskId: result.taskId,
        sanitizedMetadata: { taskStatus: result.taskStatus },
      };
    },
  };
}
