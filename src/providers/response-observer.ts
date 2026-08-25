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

const CREDENTIAL_ASSIGNMENT =
  /["']?\b(?:authorization|api[_-]?key|access[_-]?token|x-dashscope-[a-z0-9-]+)\b["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,;}"']+["']?/gi;
const BEARER_CREDENTIAL = /\bbearer\s+[^\s,;}"']+/gi;
const OPENAI_SHAPED_CREDENTIAL = /\bsk-[a-z0-9_-]{8,}\b/gi;
const ALIBABA_SHAPED_CREDENTIAL = /\bLTAI[a-z0-9]{12,}\b/gi;

export function sanitizeHttpResponseBody(
  body: string,
  configuredApiKey: string,
): RecordedHttpResponse {
  let sanitized = body.replace(CREDENTIAL_ASSIGNMENT, "[REDACTED]");
  if (configuredApiKey.length > 0) {
    sanitized = sanitized.split(configuredApiKey).join("[REDACTED]");
  }
  sanitized = sanitized
    .replace(BEARER_CREDENTIAL, "[REDACTED]")
    .replace(OPENAI_SHAPED_CREDENTIAL, "[REDACTED]")
    .replace(ALIBABA_SHAPED_CREDENTIAL, "[REDACTED]");

  return {
    body: sanitized.slice(0, MAX_PROVIDER_HTTP_BODY_CHARS),
    originalLength: body.length,
    truncated: sanitized.length > MAX_PROVIDER_HTTP_BODY_CHARS,
  };
}
