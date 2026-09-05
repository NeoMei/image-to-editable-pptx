import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import {
  ProviderFailure,
  PROVIDER_FAILURE_REASONS,
  isSafeModelIdentifier,
  type ProviderExecution,
  type ProviderFailureStatus,
  type ProviderFailureReason,
  type ProviderOperation,
} from "./routing.js";

export type HostProvider = "openai" | "gemini";

export type HostBridgeRequest = Readonly<{
  operation: ProviderOperation;
  prompt: string;
  image: Buffer;
  canvas: Readonly<{ width: number; height: number }>;
  hiddenMask?: Buffer;
  protectedMask?: Buffer;
}>;

export type HostTextOutput = Readonly<{ kind: "text"; text: string }>;
export type HostImageOutput = Readonly<{ kind: "image"; image: Buffer }>;
export type HostBridgeOutput = HostTextOutput | HostImageOutput;

/** Raw bridge success. Task-specific adapters must validate text/image content. */
export type HostBridgeSuccess = Readonly<{
  ok: true;
  model: string;
  output: HostBridgeOutput;
}>;
export type HostBridgeResult =
  | HostBridgeSuccess
  | Readonly<{ ok: false; failure: ProviderFailure }>;

export type HostBridgeResponse =
  | Readonly<{
      version: 1;
      requestId: string;
      status: "success";
      model: string;
      text: string;
      imagePath?: never;
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      status: "success";
      model: string;
      imagePath: string;
      text?: never;
    }>
  | Readonly<{
      version: 1;
      requestId: string;
      status: "failure";
      failure: Readonly<{
        status: ProviderFailureStatus;
        reason: ProviderFailureReason;
      }>;
    }>;

export type HostBridgeTiming = Readonly<{
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}>;

export type FileHostBridgeOptions = Readonly<{
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxResponseBytes?: number;
  maxArtifactBytes?: number;
  timing?: HostBridgeTiming;
}>;

export type FileHostBridge = Readonly<{
  capabilities: Readonly<
    Record<HostProvider, Readonly<Record<ProviderOperation, boolean>>>
  >;
  invoke(
    provider: HostProvider,
    request: HostBridgeRequest,
  ): Promise<HostBridgeResult>;
}>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_CONFIGURED_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_ARTIFACT_BYTES = 512 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const FailureStatusSchema = z.enum([
  "unavailable",
  "auth_unavailable",
  "retryable_exhausted",
  "policy_refused",
  "invalid_input",
  "invalid_output",
  "local_failure",
]);
const FailureReasonSchema = z.enum(PROVIDER_FAILURE_REASONS);
const OperationSchema = z.enum(["ocr", "scene", "completion"]);
const ProviderCapabilitySchema = z
  .object({
    callable: z.boolean(),
    operations: z.array(OperationSchema).max(3),
  })
  .strict();
const CapabilitiesSchema = z
  .object({
    version: z.literal(1),
    providers: z
      .object({
        openai: ProviderCapabilitySchema.optional(),
        gemini: ProviderCapabilitySchema.optional(),
      })
      .strict(),
  })
  .strict();
const ResponseSchema = z.union([
  z
    .object({
      version: z.literal(1),
      requestId: z.string().uuid(),
      status: z.literal("failure"),
      failure: z
        .object({
          status: FailureStatusSchema,
          reason: FailureReasonSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      requestId: z.string().uuid(),
      status: z.literal("success"),
      model: z.string(),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      requestId: z.string().uuid(),
      status: z.literal("success"),
      model: z.string(),
      imagePath: z.string().min(1),
    })
    .strict(),
]);

type ParsedCapabilities = z.infer<typeof CapabilitiesSchema>;
type ParsedResponse = z.infer<typeof ResponseSchema>;

const defaultTiming: HostBridgeTiming = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function invalidOutput(
  reason: ProviderFailureReason = "invalid_bridge_response",
): HostBridgeResult {
  return { ok: false, failure: new ProviderFailure("invalid_output", reason) };
}

function localFailure(
  reason: ProviderFailureReason = "bridge_local_failure",
): HostBridgeResult {
  return { ok: false, failure: new ProviderFailure("local_failure", reason) };
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function validateOptions(options: FileHostBridgeOptions): Required<
  Omit<FileHostBridgeOptions, "timing">
> & { timing: HostBridgeTiming } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxArtifactBytes =
    options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  validatePositiveInteger(timeoutMs, "timeoutMs");
  validatePositiveInteger(pollIntervalMs, "pollIntervalMs");
  validatePositiveInteger(maxResponseBytes, "maxResponseBytes");
  validatePositiveInteger(maxArtifactBytes, "maxArtifactBytes");
  if (maxResponseBytes > MAX_CONFIGURED_RESPONSE_BYTES) {
    throw new TypeError("maxResponseBytes exceeds the safe limit");
  }
  if (maxArtifactBytes > MAX_CONFIGURED_ARTIFACT_BYTES) {
    throw new TypeError("maxArtifactBytes exceeds the safe limit");
  }
  return {
    timeoutMs,
    pollIntervalMs,
    maxResponseBytes,
    maxArtifactBytes,
    timing: options.timing ?? defaultTiming,
  };
}

async function requirePrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error("Host bridge directory must be absolute");
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Host bridge path must be an existing regular directory");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Host bridge directory must not be accessible by group or others");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Host bridge directory must be owned by the current user");
  }
  return realpath(path);
}

async function readRegularFileOnce(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const pathnameMetadata = await lstat(path);
  if (
    pathnameMetadata.isSymbolicLink() ||
    !pathnameMetadata.isFile() ||
    pathnameMetadata.size > maximumBytes
  ) {
    throw new Error("Expected a bounded regular file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > maximumBytes ||
      metadata.dev !== pathnameMetadata.dev ||
      metadata.ino !== pathnameMetadata.ino
    ) {
      throw new Error("Expected a bounded regular file");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const remaining = maximumBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maximumBytes) throw new Error("File exceeds configured limit");
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(path: string, contents: string | Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

async function loadCapabilities(
  bridgeDirectory: string,
  maximumBytes: number,
): Promise<ParsedCapabilities> {
  const bytes = await readRegularFileOnce(
    join(bridgeDirectory, "capabilities.json"),
    maximumBytes,
  );
  return CapabilitiesSchema.parse(JSON.parse(bytes.toString("utf8")));
}

function capabilityMap(
  manifest: ParsedCapabilities,
): FileHostBridge["capabilities"] {
  const supports = (
    provider: HostProvider,
    operation: ProviderOperation,
  ): boolean => {
    const declaration = manifest.providers[provider];
    return (
      declaration?.callable === true && declaration.operations.includes(operation)
    );
  };
  return {
    openai: {
      ocr: supports("openai", "ocr"),
      scene: supports("openai", "scene"),
      completion: supports("openai", "completion"),
    },
    gemini: {
      ocr: supports("gemini", "ocr"),
      scene: supports("gemini", "scene"),
      completion: supports("gemini", "completion"),
    },
  };
}

function validateRequest(request: HostBridgeRequest): void {
  if (!OperationSchema.safeParse(request.operation).success) {
    throw new TypeError("Invalid host bridge operation");
  }
  if (
    typeof request.prompt !== "string" ||
    request.prompt.length < 1 ||
    request.prompt.length > MAX_PROMPT_LENGTH
  ) {
    throw new TypeError("Host bridge prompt is invalid");
  }
  if (
    !Buffer.isBuffer(request.image) ||
    request.image.length > MAX_INPUT_BYTES ||
    !request.image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new TypeError("Host bridge input PNG is invalid");
  }
  validatePositiveInteger(request.canvas.width, "canvas width");
  validatePositiveInteger(request.canvas.height, "canvas height");
  for (const mask of [request.hiddenMask, request.protectedMask]) {
    if (
      mask !== undefined &&
      (!Buffer.isBuffer(mask) ||
        mask.length > MAX_INPUT_BYTES ||
        !mask.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    ) {
      throw new TypeError("Host bridge mask PNG is invalid");
    }
  }
}

async function importLocalImage(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  if (!isAbsolute(path) || /^https?:\/\//i.test(path)) {
    throw new Error("Host image must be an absolute local path");
  }
  return readRegularFileOnce(path, maximumBytes);
}

async function interpretResponse(
  response: ParsedResponse,
  requestId: string,
  maximumArtifactBytes: number,
): Promise<HostBridgeResult> {
  if (response.requestId !== requestId) {
    return invalidOutput("mismatched_request_id");
  }
  if (response.status === "failure") {
    return {
      ok: false,
      failure: new ProviderFailure(
        response.failure.status,
        response.failure.reason,
      ),
    };
  }
  if (!isSafeModelIdentifier(response.model)) {
    return invalidOutput("invalid_model_identifier");
  }
  if ("text" in response) {
    return {
      ok: true,
      model: response.model,
      output: { kind: "text", text: response.text },
    };
  }

  try {
    const image = await importLocalImage(
      response.imagePath,
      maximumArtifactBytes,
    );
    return {
      ok: true,
      model: response.model,
      output: { kind: "image", image },
    };
  } catch {
    return invalidOutput("invalid_image_artifact");
  }
}

/**
 * Open a private file bridge backed by an existing capability manifest.
 * The returned object performs no network or shell activity.
 */
export async function createFileHostBridge(
  bridgePath: string,
  options: FileHostBridgeOptions = {},
): Promise<FileHostBridge> {
  const settings = validateOptions(options);
  const bridgeDirectory = await requirePrivateDirectory(bridgePath);
  const manifest = await loadCapabilities(
    bridgeDirectory,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const capabilities = capabilityMap(manifest);

  return {
    capabilities,
    async invoke(provider, request) {
      if (provider !== "openai" && provider !== "gemini") {
        return {
          ok: false,
          failure: new ProviderFailure("unavailable", "capability_unavailable"),
        };
      }
      try {
        validateRequest(request);
      } catch {
        return {
          ok: false,
          failure: new ProviderFailure("invalid_input", "invalid_bridge_request"),
        };
      }
      if (!capabilities[provider][request.operation]) {
        return {
          ok: false,
          failure: new ProviderFailure("unavailable", "capability_unavailable"),
        };
      }
      let requestDirectory: string;
      const requestId = crypto.randomUUID();
      try {
        const requestsDirectory = join(bridgeDirectory, "requests");
        await mkdir(requestsDirectory, { recursive: true, mode: 0o700 });
        const requestsMetadata = await lstat(requestsDirectory);
        if (
          !requestsMetadata.isDirectory() ||
          requestsMetadata.isSymbolicLink() ||
          (requestsMetadata.mode & 0o077) !== 0
        ) {
          return localFailure("unsafe_requests_directory");
        }
        requestDirectory = await mkdtemp(join(requestsDirectory, "request-"));
        await chmod(requestDirectory, 0o700);
        await writePrivateFile(join(requestDirectory, "input.png"), request.image);
        if (request.hiddenMask !== undefined) {
          await writePrivateFile(
            join(requestDirectory, "hidden-mask.png"),
            request.hiddenMask,
          );
        }
        if (request.protectedMask !== undefined) {
          await writePrivateFile(
            join(requestDirectory, "protected-mask.png"),
            request.protectedMask,
          );
        }
        const requestDocument = {
          version: 1,
          requestId,
          provider,
          operation: request.operation,
          prompt: request.prompt,
          canvas: request.canvas,
          imageFile: "input.png",
          ...(request.hiddenMask === undefined
            ? {}
            : { hiddenMaskFile: "hidden-mask.png" }),
          ...(request.protectedMask === undefined
            ? {}
            : { protectedMaskFile: "protected-mask.png" }),
        };
        const temporaryRequestPath = join(
          requestDirectory,
          ".request.json.tmp",
        );
        await writePrivateFile(
          temporaryRequestPath,
          JSON.stringify(requestDocument),
        );
        await rename(
          temporaryRequestPath,
          join(requestDirectory, "request.json"),
        );
      } catch {
        return localFailure();
      }

      const responsePath = join(requestDirectory, "response.json");
      const deadline = settings.timing.now() + settings.timeoutMs;
      while (settings.timing.now() < deadline) {
        let responseBytes: Buffer;
        try {
          responseBytes = await readRegularFileOnce(
            responsePath,
            settings.maxResponseBytes,
          );
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            await settings.timing.sleep(settings.pollIntervalMs);
            continue;
          }
          return invalidOutput();
        }

        let response: ParsedResponse;
        try {
          response = ResponseSchema.parse(
            JSON.parse(responseBytes.toString("utf8")),
          );
        } catch {
          return invalidOutput();
        }
        return interpretResponse(
          response,
          requestId,
          settings.maxArtifactBytes,
        );
      }

      return {
        ok: false,
        failure: new ProviderFailure(
          "retryable_exhausted",
          "bridge_timeout",
        ),
      };
    },
  };
}

/** Wrap a validated host adapter result for use by SerialOperationRouter. */
export function validatedHostResult<T>(
  result: HostBridgeSuccess,
  value: T,
): ProviderExecution<T> {
  return { ok: true, validated: true, model: result.model, value };
}
