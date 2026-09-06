import sharp from "sharp";

import type { ProviderRoutingConfig, RoutedProviderConfig, AppConfig } from "../config.js";
import type { OcrResult } from "../contracts.js";
import type { OcclusionCompletionProvider } from "../occlusion/contracts.js";
import type { CanvasSize, SceneGraph } from "../scene/contracts.js";
import type { FileHostBridge } from "./host-bridge.js";
import {
  createAlibabaExecutors,
  createHostExecutors,
  createOpenAiExecutors,
  type ProviderOperationExecutors,
} from "./provider-adapters.js";
import type { ProviderResponseObserver } from "./response-observer.js";
import {
  SerialOperationRouter,
  ProviderFailure,
  requireRoutingSuccess,
  type CandidateExecutor,
  type CandidateKey,
  type ProviderOperation,
  type RoutingReport,
} from "./routing.js";

export type RoutingAdapterFactory = Readonly<{
  host(bridge: FileHostBridge): Readonly<Record<"openai", ProviderOperationExecutors>>;
  openai(config: RoutedProviderConfig & { requestTimeoutMs: number; maxAttempts: number; onTransportAttempt?: (attempt: number) => void }): ProviderOperationExecutors;
  alibaba(
    config: AppConfig,
    observers?: Readonly<{ ocr?: ProviderResponseObserver; scene?: ProviderResponseObserver }>,
    onTransportAttempt?: () => void,
  ): ProviderOperationExecutors;
}>;

const defaultFactory: RoutingAdapterFactory = {
  host: createHostExecutors,
  openai: createOpenAiExecutors,
  alibaba: createAlibabaExecutors,
};

export type RoutedValue<T> = Readonly<{ value: T; model: string; candidate: CandidateKey }>;

export class ProviderRoutingSession {
  readonly #router = new SerialOperationRouter();
  readonly #routingConfig: ProviderRoutingConfig;
  readonly #host: Readonly<Record<"openai", ProviderOperationExecutors>> | undefined;
  readonly #openai: ProviderOperationExecutors | undefined;
  readonly #alibaba: ProviderOperationExecutors | undefined;
  readonly #transportCounts = new Map<string, number>();
  #currentOperation: ProviderOperation | undefined;

  constructor(options: Readonly<{
    routingConfig: ProviderRoutingConfig;
    hostBridge?: FileHostBridge;
    alibabaObservers?: Readonly<{
      ocr?: ProviderResponseObserver;
      scene?: ProviderResponseObserver;
    }>;
    factory?: RoutingAdapterFactory;
  }>) {
    this.#routingConfig = options.routingConfig;
    const factory = options.factory ?? defaultFactory;
    this.#host = options.hostBridge === undefined ? undefined : factory.host(options.hostBridge);
    const common = {
      requestTimeoutMs: options.routingConfig.requestTimeoutMs,
      maxAttempts: options.routingConfig.maxAttempts,
    };
    this.#openai = options.routingConfig.openai === undefined
      ? undefined
      : factory.openai({
          ...options.routingConfig.openai,
          ...common,
          onTransportAttempt: () => this.#recordTransport("api-openai"),
        });
    this.#alibaba = options.routingConfig.alibaba === undefined
      ? undefined
      : factory.alibaba(
          options.routingConfig.alibaba,
          options.alibabaObservers,
          () => this.#recordTransport("api-alibaba"),
        );
  }

  get report(): RoutingReport { return this.#router.report; }

  get transportAttempts(): ReadonlyArray<Readonly<{
    operation: ProviderOperation;
    candidate: CandidateKey;
    count: number;
  }>> {
    return [...this.#transportCounts.entries()].map(([key, count]) => {
      const [operation, candidate] = key.split(":") as [ProviderOperation, CandidateKey];
      return { operation, candidate, count };
    });
  }

  #recordTransport(candidate: CandidateKey): void {
    if (this.#currentOperation === undefined) return;
    const key = `${this.#currentOperation}:${candidate}`;
    this.#transportCounts.set(key, (this.#transportCounts.get(key) ?? 0) + 1);
  }

  async #route<T>(
    operation: ProviderOperation,
    invoke: (executors: ProviderOperationExecutors) => ReturnType<CandidateExecutor<T>> | undefined,
  ): Promise<RoutedValue<T>> {
    const candidate = (
      key: CandidateKey,
      executors: ProviderOperationExecutors | undefined,
    ): CandidateExecutor<T> | undefined => {
      if (executors === undefined || (operation === "completion" && key === "host-openai")) return undefined;
      return async () => {
        this.#currentOperation = operation;
        try {
          const result = invoke(executors);
          if (result === undefined) {
            return { ok: false, failure: new ProviderFailure("unavailable", "missing_candidate") };
          }
          if (key.startsWith("host-")) {
            this.#recordTransport(key);
          }
          return await result;
        } finally {
          this.#currentOperation = undefined;
        }
      };
    };
    const executors: Partial<Record<CandidateKey, CandidateExecutor<T>>> = {};
    for (const [key, executor] of [
      ["host-openai", candidate("host-openai", this.#host?.openai)],
      ["api-openai", candidate("api-openai", this.#openai)],
      ["api-alibaba", candidate("api-alibaba", this.#alibaba)],
    ] as const) {
      if (executor !== undefined) executors[key] = executor;
    }
    const result = requireRoutingSuccess(await this.#router.route<T>(operation, executors));
    return { value: result.value, model: result.selectedModel, candidate: result.selectedCandidate };
  }

  ocr(image: Buffer, canvas: CanvasSize): Promise<RoutedValue<OcrResult>> {
    return this.#route("ocr", (executors) => executors.ocr?.({ image, canvas }));
  }

  scene(image: Buffer, canvas: CanvasSize, prompt: string): Promise<RoutedValue<SceneGraph>> {
    return this.#route("scene", (executors) => executors.scene?.({ image, canvas, prompt }));
  }

  completionProvider(): OcclusionCompletionProvider {
    return {
      ownsTimeout: true,
      complete: async (request) => {
        const metadata = await sharp(request.crop).metadata();
        if (metadata.width === undefined || metadata.height === undefined) {
          throw new Error("Completion crop has no dimensions");
        }
        const routed = await this.#route("completion", (executors) =>
          executors.completion?.({
            image: request.crop,
            canvas: { width: metadata.width!, height: metadata.height! },
            prompt: request.semanticContext.join("\n"),
            hiddenMask: request.hiddenMask,
            protectedMask: request.protectedVisibleMask,
          }),
        );
        return routed.value;
      },
    };
  }

  get limits(): Pick<ProviderRoutingConfig, "maxRegionAnalysis" | "maxOcclusionCompletions" | "requestTimeoutMs"> {
    return this.#routingConfig;
  }
}
