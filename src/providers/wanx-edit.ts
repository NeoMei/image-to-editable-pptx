import { z } from "zod";

import type { AppConfig } from "../config.js";

const WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

const INPAINT_PROMPT =
  "移除白色遮罩区域中的文字、图标、线条和面板边框，延续周围米白色纸张纹理与自然阴影，不添加任何新文字、符号、物体或装饰。";

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

function timeoutSignal(deadline: number): AbortSignal {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Wanx request timed out");
  }

  return AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs)));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorDetails(code?: string, message?: string): string {
  return [code, message].filter(Boolean).join(": ");
}

function taskError(taskId: string, message: string, cause?: unknown): Error {
  return cause === undefined
    ? new Error(`Wanx task ${taskId} ${message}`)
    : new Error(`Wanx task ${taskId} ${message}`, { cause });
}

export async function inpaintBackground(
  source: Buffer,
  mask: Buffer,
  config: AppConfig,
): Promise<{ image: Buffer; taskId: string }> {
  const baseUrl = requireSafeWanxBase(config);
  const deadline = Date.now() + config.requestTimeoutMs;
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
          prompt: INPAINT_PROMPT,
          base_image_url: `data:image/png;base64,${source.toString("base64")}`,
          mask_image_url: `data:image/png;base64,${mask.toString("base64")}`,
        },
        parameters: { n: 1 },
      }),
      signal: timeoutSignal(deadline),
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
    if (Date.now() >= deadline) {
      throw taskError(taskId, "timed out");
    }

    let response: Response;
    try {
      response = await fetch(pollUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: timeoutSignal(deadline),
        redirect: "error",
      });
    } catch (error) {
      throw taskError(taskId, "poll failed", error);
    }

    if (!response.ok) {
      throw taskError(taskId, `poll failed with status ${response.status}`);
    }

    let task: z.infer<typeof TaskResponseSchema>["output"];
    try {
      task = TaskResponseSchema.parse(await response.json()).output;
    } catch (error) {
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

      let download: Response;
      try {
        download = await fetch(resultUrl, {
          method: "GET",
          headers: {},
          signal: timeoutSignal(deadline),
          redirect: "error",
        });
      } catch (error) {
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
        };
      } catch (error) {
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

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw taskError(taskId, "timed out");
    }
    await sleep(Math.min(config.pollIntervalMs, remainingMs));
  }
}
