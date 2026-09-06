export type ProviderOperation = "ocr" | "scene" | "completion";
export type ProviderChannel = "host" | "api";
export type ProviderName = "openai" | "alibaba";
export type CandidateKey =
  | "host-openai"
  | "api-openai"
  | "api-alibaba";

export type RoutingCandidate = Readonly<{
  index: number;
  key: CandidateKey;
  channel: ProviderChannel;
  provider: ProviderName;
}>;

export const ROUTING_CANDIDATES: readonly RoutingCandidate[] = Object.freeze([
  { index: 0, key: "host-openai", channel: "host", provider: "openai" },
  { index: 1, key: "api-openai", channel: "api", provider: "openai" },
  { index: 2, key: "api-alibaba", channel: "api", provider: "alibaba" },
]);

export type ProviderFailureStatus =
  | "unavailable"
  | "auth_unavailable"
  | "retryable_exhausted"
  | "policy_refused"
  | "invalid_input"
  | "invalid_output"
  | "local_failure";

const FALLBACK_FAILURES = new Set<ProviderFailureStatus>([
  "unavailable",
  "auth_unavailable",
  "retryable_exhausted",
]);
const PROVIDER_FAILURE_STATUSES = new Set<ProviderFailureStatus>([
  "unavailable",
  "auth_unavailable",
  "retryable_exhausted",
  "policy_refused",
  "invalid_input",
  "invalid_output",
  "local_failure",
]);
export const PROVIDER_FAILURE_REASONS = [
  "unavailable",
  "auth_unavailable",
  "retryable_exhausted",
  "policy_refused",
  "invalid_input",
  "invalid_output",
  "local_failure",
  "missing_candidate",
  "capability_unavailable",
  "credentials_unavailable",
  "bridge_timeout",
  "invalid_bridge_response",
  "bridge_local_failure",
  "unsafe_requests_directory",
  "invalid_bridge_request",
  "mismatched_request_id",
  "invalid_model_identifier",
  "invalid_image_artifact",
] as const;
export type ProviderFailureReason = (typeof PROVIDER_FAILURE_REASONS)[number];
const PROVIDER_FAILURE_REASON_SET = new Set<string>(PROVIDER_FAILURE_REASONS);
const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * A provider error classified for routing. `reason` is a bounded safe code,
 * never a raw provider response or exception message.
 */
export class ProviderFailure extends Error {
  readonly status: ProviderFailureStatus;
  readonly reason: ProviderFailureReason;

  constructor(
    status: ProviderFailureStatus,
    reason: ProviderFailureReason = status,
    options?: ErrorOptions,
  ) {
    if (!PROVIDER_FAILURE_STATUSES.has(status)) {
      throw new TypeError("Unknown provider failure status");
    }
    if (!PROVIDER_FAILURE_REASON_SET.has(reason)) {
      throw new TypeError("Unknown provider failure reason");
    }
    super(`Provider failure: ${status} (${reason})`, options);
    this.name = "ProviderFailure";
    this.status = status;
    this.reason = reason;
  }
}

export type ValidatedProviderSuccess<T> = Readonly<{
  ok: true;
  validated: true;
  model: string;
  value: T;
}>;

export type ProviderExecution<T> =
  | ValidatedProviderSuccess<T>
  | Readonly<{ ok: false; failure: ProviderFailure }>;

export type CandidateExecutorContext = Readonly<{
  sequence: number;
  operation: ProviderOperation;
  candidate: RoutingCandidate;
}>;

export type CandidateExecutor<T> = (
  context: CandidateExecutorContext,
) => Promise<ProviderExecution<T>>;

export type RoutingAttempt =
  | Readonly<{
      candidate: CandidateKey;
      status: "success";
      model: string;
    }>
  | Readonly<{
      candidate: CandidateKey;
      status: ProviderFailureStatus;
      disposition: ProviderFailureReason;
    }>;

type RoutingResultBase = Readonly<{
  sequence: number;
  operation: ProviderOperation;
  attempts: readonly RoutingAttempt[];
}>;

export type RoutingSuccess<T> = RoutingResultBase &
  Readonly<{
    outcome: "success";
    selectedCandidate: CandidateKey;
    selectedModel: string;
    value: T;
  }>;

export type RoutingFailure = RoutingResultBase &
  Readonly<{
    outcome: "fatal" | "exhausted";
    selectedCandidate: undefined;
    selectedModel: undefined;
  }>;

export type RoutingResult<T> = RoutingSuccess<T> | RoutingFailure;

/** Terminal routing outcome suitable for propagation through optional stages. */
export class RoutingTerminalError extends Error {
  readonly result: RoutingFailure;

  constructor(result: RoutingFailure) {
    super(`Provider routing ${result.outcome} for ${result.operation}`);
    this.name = "RoutingTerminalError";
    this.result = result;
  }
}

export function requireRoutingSuccess<T>(result: RoutingResult<T>): RoutingSuccess<T> {
  if (result.outcome !== "success") throw new RoutingTerminalError(result);
  return result;
}

export type RoutingOperationReport = Readonly<{
  sequence: number;
  operation: ProviderOperation;
  outcome: "success" | "fatal" | "exhausted";
  selectedCandidate: CandidateKey | undefined;
  selectedModel: string | undefined;
  attempts: readonly RoutingAttempt[];
}>;

export type RoutingReport = Readonly<{
  mode: "serial-forward-sticky";
  stopped: boolean;
  operations: readonly RoutingOperationReport[];
}>;

export function isSafeModelIdentifier(model: unknown): model is string {
  return typeof model === "string" && MODEL_IDENTIFIER_PATTERN.test(model);
}

function localFailureAttempt(candidate: RoutingCandidate): RoutingAttempt {
  return {
    candidate: candidate.key,
    status: "local_failure",
    disposition: "local_failure",
  };
}

function validateExecution<T>(value: unknown): ProviderExecution<T> {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new TypeError("Candidate executor returned an invalid result");
  }

  if (value.ok === false) {
    if (!("failure" in value) || !(value.failure instanceof ProviderFailure)) {
      throw new TypeError("Candidate executor returned an invalid failure");
    }
    return value as ProviderExecution<T>;
  }

  if (
    value.ok !== true ||
    !("validated" in value) ||
    value.validated !== true ||
    !("model" in value) ||
    !isSafeModelIdentifier(value.model) ||
    !("value" in value)
  ) {
    throw new TypeError("Candidate executor returned an invalid success");
  }
  return value as ProviderExecution<T>;
}

/**
 * Serial fallback policy with one forward-only sticky cursor per operation.
 * Create one instance per pipeline run; concurrent callers are queued.
 */
export class SerialOperationRouter {
  readonly #cursor: Record<ProviderOperation, number> = {
    ocr: 0,
    scene: 0,
    completion: 0,
  };
  readonly #operations: RoutingOperationReport[] = [];
  #stopped = false;
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();

  get report(): RoutingReport {
    return {
      mode: "serial-forward-sticky",
      stopped: this.#stopped,
      operations: this.#operations.map((operation) => ({
        ...operation,
        attempts: operation.attempts.map((attempt) => ({ ...attempt })),
      })),
    };
  }

  route<T>(
    operation: ProviderOperation,
    executors: Partial<Record<CandidateKey, CandidateExecutor<T>>>,
  ): Promise<RoutingResult<T>> {
    const pending = this.#tail.then(() => this.#routeSerial(operation, executors));
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #routeSerial<T>(
    operation: ProviderOperation,
    executors: Partial<Record<CandidateKey, CandidateExecutor<T>>>,
  ): Promise<RoutingResult<T>> {
    if (this.#stopped) {
      throw new Error("Provider routing has stopped after a terminal operation");
    }
    if (!(operation in this.#cursor)) {
      throw new TypeError("Unsupported provider operation");
    }
    if (typeof executors !== "object" || executors === null) {
      throw new TypeError("Candidate executors must be an object");
    }

    const sequence = ++this.#sequence;
    const attempts: RoutingAttempt[] = [];
    const startIndex = this.#cursor[operation];

    for (const candidate of ROUTING_CANDIDATES.slice(startIndex)) {
      const executor = executors[candidate.key];
      if (executor === undefined) {
        attempts.push({
          candidate: candidate.key,
          status: "unavailable",
          disposition: "missing_candidate",
        });
        continue;
      }

      let execution: ProviderExecution<T>;
      try {
        execution = validateExecution<T>(
          await executor({ sequence, operation, candidate }),
        );
      } catch {
        attempts.push(localFailureAttempt(candidate));
        return this.#stop<T>(sequence, operation, "fatal", attempts);
      }

      if (execution.ok) {
        const attempt: RoutingAttempt = {
          candidate: candidate.key,
          status: "success",
          model: execution.model,
        };
        attempts.push(attempt);
        this.#cursor[operation] = candidate.index;
        const result: RoutingSuccess<T> = {
          sequence,
          operation,
          outcome: "success",
          selectedCandidate: candidate.key,
          selectedModel: execution.model,
          value: execution.value,
          attempts,
        };
        this.#operations.push({
          sequence,
          operation,
          outcome: "success",
          selectedCandidate: candidate.key,
          selectedModel: execution.model,
          attempts: attempts.map((entry) => ({ ...entry })),
        });
        return result;
      }

      attempts.push({
        candidate: candidate.key,
        status: execution.failure.status,
        disposition: execution.failure.reason,
      });
      if (!FALLBACK_FAILURES.has(execution.failure.status)) {
        return this.#stop<T>(sequence, operation, "fatal", attempts);
      }
    }

    return this.#stop<T>(sequence, operation, "exhausted", attempts);
  }

  #stop<T>(
    sequence: number,
    operation: ProviderOperation,
    outcome: "fatal" | "exhausted",
    attempts: readonly RoutingAttempt[],
  ): RoutingResult<T> {
    this.#stopped = true;
    const result: RoutingFailure = {
      sequence,
      operation,
      outcome,
      selectedCandidate: undefined,
      selectedModel: undefined,
      attempts: attempts.map((attempt) => ({ ...attempt })),
    };
    this.#operations.push({ ...result });
    return result;
  }
}
