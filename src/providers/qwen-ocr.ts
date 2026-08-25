import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  OcrResultSchema,
  type OcrResult,
} from "../contracts.js";
import type { ProviderResponseObserver } from "./response-observer.js";

const WORKSPACE_ID_PATTERN =
  /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

const OcrResponseSchema = z.object({
  output: z.object({
    choices: z.array(
      z.object({
        message: z.object({
          content: z.array(
            z.object({
              ocr_result: z.object({
                words_info: z.array(
                  z.object({
                    text: z.string(),
                    location: z.tuple([
                      z.number(),
                      z.number(),
                      z.number(),
                      z.number(),
                      z.number(),
                      z.number(),
                      z.number(),
                      z.number(),
                    ]),
                  }),
                ),
              }),
            }),
          ),
        }),
      }),
    ),
  }),
});

function requireSafeOcrBase(config: AppConfig): string {
  if (!WORKSPACE_ID_PATTERN.test(config.workspaceId)) {
    throw new Error("Expected a safe Alibaba China OCR base URL");
  }

  const expectedHostname =
    `${config.workspaceId}.cn-beijing.maas.aliyuncs.com`.toLowerCase();
  const expectedHref = `https://${expectedHostname}/api/v1`;

  let url: URL;
  try {
    url = new URL(config.dashscopeApiBase);
  } catch {
    throw new Error("Expected a safe Alibaba China OCR base URL");
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
    throw new Error("Expected a safe Alibaba China OCR base URL");
  }

  return expectedHref;
}

function isCoordinateFreeTextResponse(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const output = "output" in payload ? payload.output : undefined;
  if (typeof output !== "object" || output === null || !("choices" in output)) {
    return false;
  }
  if (!Array.isArray(output.choices)) return false;

  return output.choices.some((choice) => {
    if (typeof choice !== "object" || choice === null || !("message" in choice)) {
      return false;
    }
    const message = choice.message;
    if (
      typeof message !== "object" ||
      message === null ||
      !("content" in message) ||
      !Array.isArray(message.content)
    ) {
      return false;
    }
    return (message.content as unknown[]).some(
      (content: unknown) =>
        typeof content === "object" &&
        content !== null &&
        "text" in content &&
        typeof content.text === "string" &&
        !("ocr_result" in content),
    );
  });
}

export function parseQwenOcrResponse(payload: unknown): OcrResult {
  let parsed: z.infer<typeof OcrResponseSchema>;

  try {
    parsed = OcrResponseSchema.parse(payload);
  } catch (error) {
    const detail = isCoordinateFreeTextResponse(payload)
      ? ": coordinates require the advanced_recognition task"
      : "";
    throw new Error(`Invalid Qwen OCR response${detail}`, { cause: error });
  }

  const lines = parsed.output.choices.flatMap((choice) =>
    choice.message.content.flatMap((content) =>
      content.ocr_result.words_info.map(({ text, location }) => {
        const quad = [
          { x: location[0], y: location[1] },
          { x: location[2], y: location[3] },
          { x: location[4], y: location[5] },
          { x: location[6], y: location[7] },
        ] as const;
        const xValues = quad.map((point) => point.x);
        const yValues = quad.map((point) => point.y);
        const minX = Math.min(...xValues);
        const maxX = Math.max(...xValues);
        const minY = Math.min(...yValues);
        const maxY = Math.max(...yValues);

        return {
          text,
          bbox: {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
          },
          quad,
        };
      }),
    ),
  );

  try {
    return OcrResultSchema.parse({ lines });
  } catch (error) {
    throw new Error("Invalid normalized Qwen OCR response", { cause: error });
  }
}

export async function recognizeText(
  image: Buffer,
  config: AppConfig,
  observer?: ProviderResponseObserver,
): Promise<OcrResult> {
  const baseUrl = requireSafeOcrBase(config);
  const response = await fetch(
    `${baseUrl}/services/aigc/multimodal-generation/generation`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.ocrModel,
        input: {
          messages: [
            {
              role: "user",
              content: [
                {
                  image: `data:image/png;base64,${image.toString("base64")}`,
                  enable_rotate: false,
                },
              ],
            },
          ],
        },
        parameters: { ocr_options: { task: "advanced_recognition" } },
      }),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
      redirect: "error",
    },
  );

  if (!response.ok) {
    throw new Error(`Qwen OCR request failed with status ${response.status}`);
  }

  const responseBody = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(responseBody);
  } catch (cause) {
    const error = new Error("Qwen OCR HTTP response is not valid JSON", {
      cause,
    });
    await observer?.recordRawHttpResponse(responseBody);
    await observer?.recordParseError(error);
    throw error;
  }
  await observer?.recordRawResponse(payload);
  try {
    return parseQwenOcrResponse(payload);
  } catch (error) {
    await observer?.recordParseError(error);
    throw error;
  }
}
