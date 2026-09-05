import assert from "node:assert/strict";
import test from "node:test";

import {
  RoutingTerminalError,
  ProviderFailure,
  ROUTING_CANDIDATES,
  SerialOperationRouter,
  type CandidateExecutor,
  type CandidateKey,
} from "../src/providers/routing.js";

test("typed routing terminal error preserves only safe terminal routing data", () => {
  const result = {
    sequence: 2,
    operation: "scene" as const,
    outcome: "fatal" as const,
    selectedCandidate: undefined,
    selectedModel: undefined,
    attempts: [{
      candidate: "api-openai" as const,
      status: "policy_refused" as const,
      disposition: "policy_refused" as const,
    }],
  };
  const error = new RoutingTerminalError(result);
  assert.equal(error.name, "RoutingTerminalError");
  assert.equal(error.result, result);
  assert.doesNotMatch(error.message, /secret|provider response/i);
});

function success<T>(model: string, value: T) {
  return { ok: true, validated: true, model, value } as const;
}

function failure(
  status: ConstructorParameters<typeof ProviderFailure>[0],
  reason: ConstructorParameters<typeof ProviderFailure>[1],
) {
  return { ok: false, failure: new ProviderFailure(status, reason) } as const;
}

test("uses fixed order, records missing and unavailable candidates, and keeps independent operation cursors", async () => {
  assert.deepEqual(
    ROUTING_CANDIDATES.map((candidate) => candidate.key),
    [
      "host-openai",
      "api-openai",
      "host-gemini",
      "api-gemini",
      "api-alibaba",
    ],
  );

  const calls: string[] = [];
  const router = new SerialOperationRouter();
  const ocrExecutors: Partial<Record<CandidateKey, CandidateExecutor<string>>> = {
    "api-openai": async ({ candidate }) => {
      calls.push(`ocr:${candidate.key}`);
      return failure("auth_unavailable", "credentials_unavailable");
    },
    "host-gemini": async ({ candidate }) => {
      calls.push(`ocr:${candidate.key}`);
      return success("gemini-2.5-flash", "ocr-result");
    },
  };

  const first = await router.route("ocr", ocrExecutors);
  assert.equal(first.outcome, "success");
  assert.equal(first.selectedCandidate, "host-gemini");
  assert.equal(first.selectedModel, "gemini-2.5-flash");
  assert.deepEqual(first.attempts, [
    {
      candidate: "host-openai",
      status: "unavailable",
      disposition: "missing_candidate",
    },
    {
      candidate: "api-openai",
      status: "auth_unavailable",
      disposition: "credentials_unavailable",
    },
    {
      candidate: "host-gemini",
      status: "success",
      model: "gemini-2.5-flash",
    },
  ]);

  const second = await router.route("ocr", ocrExecutors);
  assert.equal(second.selectedCandidate, "host-gemini");
  assert.deepEqual(second.attempts.map((attempt) => attempt.candidate), [
    "host-gemini",
  ]);

  const scene = await router.route("scene", {
    "host-openai": async ({ candidate }) => {
      calls.push(`scene:${candidate.key}`);
      return success("gpt-4.1", "scene-result");
    },
  });
  assert.equal(scene.selectedCandidate, "host-openai");
  assert.deepEqual(calls, [
    "ocr:api-openai",
    "ocr:host-gemini",
    "ocr:host-gemini",
    "scene:host-openai",
  ]);
  assert.deepEqual(
    router.report.operations.map(({ sequence, operation }) => ({
      sequence,
      operation,
    })),
    [
      { sequence: 1, operation: "ocr" },
      { sequence: 2, operation: "ocr" },
      { sequence: 3, operation: "scene" },
    ],
  );
});

test("sticky routing only moves forward after a retryable failure", async () => {
  const calls: CandidateKey[] = [];
  let hostGeminiCalls = 0;
  const router = new SerialOperationRouter();
  const executors: Partial<Record<CandidateKey, CandidateExecutor<number>>> = {
    "host-gemini": async ({ candidate }) => {
      calls.push(candidate.key);
      hostGeminiCalls += 1;
      return hostGeminiCalls === 1
        ? success("gemini-host", 1)
        : failure("retryable_exhausted", "retryable_exhausted");
    },
    "api-gemini": async ({ candidate }) => {
      calls.push(candidate.key);
      return success("gemini-api", 2);
    },
  };

  const first = await router.route("completion", executors);
  const second = await router.route("completion", executors);
  const third = await router.route("completion", executors);
  assert.equal(first.outcome, "success");
  assert.equal(second.outcome, "success");
  assert.equal(third.outcome, "success");
  if (
    first.outcome !== "success" ||
    second.outcome !== "success" ||
    third.outcome !== "success"
  ) {
    assert.fail("expected routing successes");
  }
  assert.equal(first.value, 1);
  assert.equal(second.value, 2);
  assert.equal(third.value, 2);
  assert.deepEqual(calls, [
    "host-gemini",
    "host-gemini",
    "api-gemini",
    "api-gemini",
  ]);
});

test("a fatal failure short-circuits candidates and permanently stops the router", async () => {
  let laterCalled = false;
  const router = new SerialOperationRouter();
  const result = await router.route("scene", {
    "host-openai": async () =>
      failure("policy_refused", "policy_refused"),
    "api-openai": async () => {
      laterCalled = true;
      return success("must-not-run", "bad");
    },
  });

  assert.equal(result.outcome, "fatal");
  assert.equal(result.selectedCandidate, undefined);
  assert.equal(laterCalled, false);
  assert.equal(router.report.stopped, true);
  await assert.rejects(
    router.route("ocr", {}),
    /routing has stopped/i,
  );
});

test("exhaustion is explicit, ordered, and never records provider error strings", async () => {
  const secret = "Bearer sk-do-not-report";
  const router = new SerialOperationRouter();
  const executors = Object.fromEntries(
    ROUTING_CANDIDATES.map((candidate, index) => [
      candidate.key,
      async () =>
        failure(
          index % 2 === 0 ? "unavailable" : "retryable_exhausted",
          index % 2 === 0 ? "capability_unavailable" : "retryable_exhausted",
        ),
    ]),
  ) as unknown as Record<CandidateKey, CandidateExecutor<never>>;

  const result = await router.route("ocr", executors);
  assert.equal(result.outcome, "exhausted");
  assert.deepEqual(
    result.attempts.map(({ candidate, status }) => ({ candidate, status })),
    [
      { candidate: "host-openai", status: "unavailable" },
      { candidate: "api-openai", status: "retryable_exhausted" },
      { candidate: "host-gemini", status: "unavailable" },
      { candidate: "api-gemini", status: "retryable_exhausted" },
      { candidate: "api-alibaba", status: "unavailable" },
    ],
  );
  assert.equal(JSON.stringify(router.report).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("message"), false);
});

test("unknown executor exceptions and invalid model identities become local_failure", async () => {
  for (const execute of [
    async () => {
      throw new Error("raw provider error with secret-token");
    },
    async () => success("unsafe model\nsecret-token", "value"),
  ]) {
    const router = new SerialOperationRouter();
    const result = await router.route("ocr", {
      "host-openai": execute,
    });
    assert.equal(result.outcome, "fatal");
    assert.deepEqual(result.attempts, [
      {
        candidate: "host-openai",
        status: "local_failure",
        disposition: "local_failure",
      },
    ]);
    assert.equal(JSON.stringify(router.report).includes("secret-token"), false);
  }
});

test("concurrent route calls execute serially without interleaving", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const router = new SerialOperationRouter();

  const first = router.route("ocr", {
    "host-openai": async () => {
      events.push("first-start");
      firstStarted();
      await firstGate;
      events.push("first-end");
      return success("gpt-4.1", "one");
    },
  });
  const second = router.route("scene", {
    "host-openai": async () => {
      events.push("second-start");
      return success("gpt-4.1", "two");
    },
  });

  await started;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("separate router instances have separate sticky and stopped state", async () => {
  const stopped = new SerialOperationRouter();
  const fresh = new SerialOperationRouter();
  await stopped.route("ocr", {
    "host-openai": async () => failure("invalid_input", "invalid_input"),
  });

  const result = await fresh.route("ocr", {
    "host-openai": async () => success("gpt-4.1", "ok"),
  });
  assert.equal(result.outcome, "success");
  assert.equal(fresh.report.stopped, false);
});
