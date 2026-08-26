import { redactProviderText } from "../recording.js";

export type ProviderResponseObserver = {
  recordRawResponse(payload: unknown): Promise<void>;
  recordRawHttpResponse(body: string): Promise<void>;
  recordParseError(error: unknown): Promise<void>;
};

export const MAX_PROVIDER_HTTP_BODY_CHARS = 65_536;

export type RecordedHttpResponse = {
  body: string;
  originalLength: number;
  truncated: boolean;
};

export function sanitizeHttpResponseBody(
  body: string,
  configuredApiKey: string,
): RecordedHttpResponse {
  const sanitized = redactProviderText(body, configuredApiKey);

  return {
    body: sanitized.slice(0, MAX_PROVIDER_HTTP_BODY_CHARS),
    originalLength: body.length,
    truncated: sanitized.length > MAX_PROVIDER_HTTP_BODY_CHARS,
  };
}
