import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import {
  OcclusionCompletionBudget,
  completeOccludedCandidate,
  type OcclusionCompletionInput,
  type OcclusionCompletionProvider,
} from "../src/occlusion/complete.js";
import { createCountedCompletionProvider } from "../src/pipeline.js";
import { RoutingTerminalError } from "../src/providers/routing.js";

const WIDTH = 9;
const HEIGHT = 5;

function pixelOffset(x: number, y: number, width = WIDTH): number {
  return (y * width + x) * 4;
}

async function pngFromRgba(
  rgba: Buffer,
  width = WIDTH,
  height = HEIGHT,
): Promise<Buffer> {
  return sharp(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function maskPng(
  points: ReadonlyArray<readonly [number, number]>,
  width = WIDTH,
  height = HEIGHT,
): Promise<Buffer> {
  const mask = Buffer.alloc(width * height);
  for (const [x, y] of points) mask[y * width + x] = 255;
  return sharp(mask, {
    raw: { width, height, channels: 1 },
  })
    .png()
    .toBuffer();
}

async function fixture(): Promise<{
  input: OcclusionCompletionInput;
  completedCrop: Buffer;
  sourceRgba: Buffer;
}> {
  const sourceRgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    sourceRgba.set([10, 20, 30, 255], index * 4);
  }
  const visiblePoints = [
    [1, 2],
    [2, 2],
    [6, 2],
    [7, 2],
  ] as const;
  for (const [x, y] of visiblePoints) {
    sourceRgba.set([200, 80, 40, 255], pixelOffset(x, y));
  }
  const completedRgba = Buffer.from(sourceRgba);
  for (const x of [3, 4, 5]) {
    completedRgba.set([200, 80, 40, 255], pixelOffset(x, 2));
  }
  const occluderPoints: Array<readonly [number, number]> = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (const x of [3, 4, 5]) occluderPoints.push([x, y]);
  }
  return {
    sourceRgba,
    completedCrop: await pngFromRgba(completedRgba),
    input: {
      candidate: {
        bbox: { x: 11, y: 13, width: 7, height: 3 },
        occlusion: {
          occluderIds: ["front-node"],
          hiddenMaskRequired: true,
        },
      },
      canvas: { width: 90, height: 50 },
      cropBounds: { x: 10, y: 12, width: WIDTH, height: HEIGHT },
      crop: await pngFromRgba(sourceRgba),
      visibleMask: await maskPng(visiblePoints),
      occluderMasks: new Map([
        ["front-node", await maskPng(occluderPoints)],
        ["unrelated-node", await maskPng([[0, 0]])],
      ]),
      semanticContext: ["rear candidate continues behind accepted occluder"],
      budget: new OcclusionCompletionBudget(4),
      timeoutMs: 100,
    },
  };
}

function providerReturning(image: Buffer): OcclusionCompletionProvider {
  return {
    async complete() {
      return {
        image,
        modelId: "provider-model",
        taskId: "provider-task",
        sanitizedMetadata: { status: "succeeded", attempts: 1 },
      };
    },
  };
}

async function alphaOf(image: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, WIDTH);
  assert.equal(info.height, HEIGHT);
  const alpha = Buffer.alloc(WIDTH * HEIGHT);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = data[index * 4 + 3]!;
  }
  return alpha;
}

test("subtracts accepted occluders from a contaminated foreground mask", async () => {
  const { input, completedCrop } = await fixture();
  const points: Array<readonly [number, number]> = [[1, 2], [2, 2], [6, 2], [7, 2]];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (const x of [3, 4, 5]) points.push([x, y]);
  }
  let calls = 0;
  let protectedMask: Buffer | undefined;
  const result = await completeOccludedCandidate(
    { ...input, visibleMask: await maskPng(points) },
    {
      async complete(request) {
        calls += 1;
        protectedMask = request.protectedVisibleMask;
        return providerReturning(completedCrop).complete(request);
      },
    },
  );
  assert.equal(calls, 1);
  assert.ok(result);
  assert.deepEqual(result.visibleMask, protectedMask);
  const visible = await alphaOf(result.visibleMask);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (const x of [3, 4, 5]) assert.equal(visible[y * WIDTH + x], 0);
  }
  for (const x of [1, 2, 6, 7]) assert.equal(visible[2 * WIDTH + x], 255);
  assert.equal(result.provenance.kind, "composite");
  if (result.provenance.kind !== "composite") assert.fail("expected composite provenance");
  assert.equal(result.provenance.visibleMaskSha256,
    createHash("sha256").update(result.visibleMask).digest("hex"));
  assert.equal(result.reviewRequired, true);
});

test("overlapping occluder pixels alone cannot supply opposing visible contacts", async () => {
  const { input, completedCrop } = await fixture();
  const points: Array<readonly [number, number]> = [[1, 2], [2, 2]];
  for (let y = 0; y < HEIGHT; y += 1) {
    for (const x of [3, 4, 5]) points.push([x, y]);
  }
  let calls = 0;
  const result = await completeOccludedCandidate(
    { ...input, visibleMask: await maskPng(points) },
    { async complete(request) {
      calls += 1;
      return providerReturning(completedCrop).complete(request);
    } },
  );
  assert.equal(calls, 0);
  assert.equal(result, undefined);
});

test("does not call a provider without an accepted occludes relation", async () => {
  const { input, completedCrop } = await fixture();
  let calls = 0;
  const result = await completeOccludedCandidate(
    { ...input, candidate: { bbox: input.candidate.bbox } },
    {
      async complete() {
        calls += 1;
        return providerReturning(completedCrop).complete({
          crop: input.crop,
          hiddenMask: input.visibleMask,
          protectedVisibleMask: input.visibleMask,
          semanticContext: [],
        });
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("does not call a provider when the visible contour is locally complete", async () => {
  const { input, completedCrop } = await fixture();
  let calls = 0;
  const result = await completeOccludedCandidate(
    {
      ...input,
      visibleMask: await maskPng([
        [0, 0],
        [0, 1],
      ]),
    },
    {
      async complete() {
        calls += 1;
        return providerReturning(completedCrop).complete({
          crop: input.crop,
          hiddenMask: input.visibleMask,
          protectedVisibleMask: input.visibleMask,
          semanticContext: [],
        });
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("rejects a full-slide request before calling the provider", async () => {
  const { input, completedCrop } = await fixture();
  let calls = 0;
  const result = await completeOccludedCandidate(
    {
      ...input,
      canvas: { width: WIDTH, height: HEIGHT },
      cropBounds: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    },
    {
      async complete() {
        calls += 1;
        return providerReturning(completedCrop).complete({
          crop: input.crop,
          hiddenMask: input.visibleMask,
          protectedVisibleMask: input.visibleMask,
          semanticContext: [],
        });
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("rejects an almost-full-slide crop that exceeds canonical candidate padding", async () => {
  const width = 89;
  const height = 50;
  const sourceRgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    sourceRgba.set([10, 20, 30, 255], index * 4);
  }
  const completedRgba = Buffer.from(sourceRgba);
  const visiblePoints = [
    [10, 25],
    [11, 25],
    [15, 25],
    [16, 25],
  ] as const;
  for (const [x, y] of visiblePoints) {
    sourceRgba.set([200, 80, 40, 255], pixelOffset(x, y, width));
    completedRgba.set([200, 80, 40, 255], pixelOffset(x, y, width));
  }
  const occluderPoints: Array<readonly [number, number]> = [];
  for (let y = 0; y < height; y += 1) {
    for (const x of [12, 13, 14]) occluderPoints.push([x, y]);
  }
  for (const x of [12, 13, 14]) {
    completedRgba.set([200, 80, 40, 255], pixelOffset(x, 25, width));
  }
  let calls = 0;
  const result = await completeOccludedCandidate(
    {
      candidate: {
        bbox: { x: 10, y: 24, width: 7, height: 3 },
        occlusion: {
          occluderIds: ["front-node"],
          hiddenMaskRequired: true,
        },
      },
      canvas: { width: 90, height: 50 },
      cropBounds: { x: 0, y: 0, width, height },
      crop: await pngFromRgba(sourceRgba, width, height),
      visibleMask: await maskPng(visiblePoints, width, height),
      occluderMasks: new Map([
        ["front-node", await maskPng(occluderPoints, width, height)],
      ]),
      semanticContext: [],
      budget: new OcclusionCompletionBudget(1),
      timeoutMs: 100,
    },
    {
      async complete() {
        calls += 1;
        return {
          image: await pngFromRgba(completedRgba, width, height),
          modelId: "provider-model",
          taskId: "provider-task",
          sanitizedMetadata: {},
        };
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("rejects opposing occluder contacts that are not locally aligned", async () => {
  const current = await fixture();
  const misalignedVisible = await maskPng([
    [1, 1],
    [2, 1],
    [6, 3],
    [7, 3],
  ]);
  let calls = 0;
  const result = await completeOccludedCandidate(
    { ...current.input, visibleMask: misalignedVisible },
    {
      async complete() {
        calls += 1;
        return providerReturning(current.completedCrop).complete({
          crop: current.input.crop,
          hiddenMask: current.input.visibleMask,
          protectedVisibleMask: current.input.visibleMask,
          semanticContext: [],
        });
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("rejects aligned contact pixels disconnected from a continuing visible contour", async () => {
  const current = await fixture();
  const disconnectedContacts = await maskPng([
    [2, 2],
    [6, 2],
  ]);
  let calls = 0;
  const result = await completeOccludedCandidate(
    { ...current.input, visibleMask: disconnectedContacts },
    {
      async complete() {
        calls += 1;
        return providerReturning(current.completedCrop).complete({
          crop: current.input.crop,
          hiddenMask: current.input.visibleMask,
          protectedVisibleMask: current.input.visibleMask,
          semanticContext: [],
        });
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(calls, 0);
});

test("sends only the padded candidate crop and crop-sized masks", async () => {
  const { input, completedCrop } = await fixture();
  const sourceSnapshot = Buffer.from(input.crop);
  let calls = 0;
  let capturedRequest:
    | Parameters<OcclusionCompletionProvider["complete"]>[0]
    | undefined;
  const result = await completeOccludedCandidate(input, {
    async complete(request) {
      calls += 1;
      capturedRequest = request;
      return {
        image: completedCrop,
        modelId: "provider-model",
        taskId: "provider-task",
        sanitizedMetadata: { status: "succeeded" },
      };
    },
  });
  assert.ok(result);
  assert.equal(calls, 1);
  assert.ok(capturedRequest);
  assert.notDeepEqual(capturedRequest.crop, input.crop);
  assert.deepEqual(input.crop, sourceSnapshot);
  assert.deepEqual(capturedRequest.protectedVisibleMask, input.visibleMask);
  assert.deepEqual(capturedRequest.semanticContext, input.semanticContext);
  for (const buffer of [
    capturedRequest.crop,
    capturedRequest.hiddenMask,
    capturedRequest.protectedVisibleMask,
  ]) {
    const metadata = await sharp(buffer).metadata();
    assert.deepEqual(
      { width: metadata.width, height: metadata.height },
      { width: WIDTH, height: HEIGHT },
    );
    assert.notDeepEqual(
      { width: metadata.width, height: metadata.height },
      { width: 90, height: 50 },
      "the full slide must never be sent",
    );
  }
  const { data: hidden, info: hiddenInfo } = await sharp(
    capturedRequest.hiddenMask,
  )
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(hidden[(2 * WIDTH + 4) * hiddenInfo.channels], 255);
  assert.equal(
    hidden[0],
    0,
    "unrelated occluder geometry must not leak into the mask",
  );
  const cleared = await sharp(capturedRequest.crop).ensureAlpha().raw().toBuffer();
  assert.deepEqual(
    [...cleared.subarray(pixelOffset(4, 2), pixelOffset(4, 2) + 4)],
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    [...cleared.subarray(pixelOffset(1, 2), pixelOffset(1, 2) + 4)],
    [200, 80, 40, 255],
  );
});

test("rejects provider output that modifies any protected visible RGBA byte", async () => {
  const { input, completedCrop } = await fixture();
  const modified = await sharp(completedCrop).ensureAlpha().raw().toBuffer();
  const visibleOffset = pixelOffset(1, 2);
  modified[visibleOffset] = modified[visibleOffset]! ^ 0xff;
  const result = await completeOccludedCandidate(
    input,
    providerReturning(await pngFromRgba(modified)),
  );
  assert.equal(result, undefined);
});

test("rejects provider writes outside the derived hidden mask", async () => {
  const { input, completedCrop } = await fixture();
  const modified = await sharp(completedCrop).ensureAlpha().raw().toBuffer();
  const outsideOffset = pixelOffset(8, 4);
  modified[outsideOffset] = modified[outsideOffset]! ^ 0xff;
  const result = await completeOccludedCandidate(
    input,
    providerReturning(await pngFromRgba(modified)),
  );
  assert.equal(result, undefined);
});

test("rejects a disconnected completion", async () => {
  const { input, sourceRgba } = await fixture();
  const disconnected = Buffer.from(sourceRgba);
  disconnected.set([200, 80, 40, 255], pixelOffset(4, 0));
  const result = await completeOccludedCandidate(
    input,
    providerReturning(await pngFromRgba(disconnected)),
  );
  assert.equal(result, undefined);
});

test("provider failures and timeouts leave the original candidate in the background", async () => {
  const failed = await fixture();
  assert.equal(
    await completeOccludedCandidate(failed.input, {
      async complete() {
        throw new Error("provider failed");
      },
    }),
    undefined,
  );

  const timedOut = await fixture();
  assert.equal(
    await completeOccludedCandidate(
      { ...timedOut.input, timeoutMs: 5 },
      {
        async complete() {
          return new Promise(() => undefined);
        },
      },
    ),
    undefined,
  );
});

test("counted routed completion retains timeout ownership through candidate completion", async () => {
  const { input, completedCrop } = await fixture();
  let requests = 0;
  const provider = createCountedCompletionProvider({
    ownsTimeout: true,
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return providerReturning(completedCrop).complete({
        crop: input.crop,
        hiddenMask: input.visibleMask,
        protectedVisibleMask: input.visibleMask,
        semanticContext: [],
      });
    },
  }, () => { requests += 1; });

  const startedAt = performance.now();
  const result = await completeOccludedCandidate(
    { ...input, timeoutMs: 5 },
    provider,
  );

  assert.ok(performance.now() - startedAt >= 15);
  assert.ok(result);
  assert.equal(result.provenance.kind, "composite");
  if (result.provenance.kind !== "composite") return;
  assert.equal(result.provenance.modelId, "provider-model");
  assert.equal(requests, 1);
});

test("fatal routed completion escapes the optional quality fallback", async () => {
  const { input } = await fixture();
  const terminal = new RoutingTerminalError({
    sequence: 1,
    operation: "completion",
    outcome: "fatal",
    selectedCandidate: undefined,
    selectedModel: undefined,
    attempts: [{
      candidate: "api-openai",
      status: "policy_refused",
      disposition: "policy_refused",
    }],
  });
  await assert.rejects(
    completeOccludedCandidate(input, {
      ownsTimeout: true,
      async complete() { throw terminal; },
    }),
    terminal,
  );
});

test("zero disables completion and a shared budget permits at most four calls", async () => {
  const disabled = await fixture();
  let disabledCalls = 0;
  assert.equal(
    await completeOccludedCandidate(
      { ...disabled.input, budget: new OcclusionCompletionBudget(0) },
      {
        async complete() {
          disabledCalls += 1;
          return providerReturning(disabled.completedCrop).complete({
            crop: disabled.input.crop,
            hiddenMask: disabled.input.visibleMask,
            protectedVisibleMask: disabled.input.visibleMask,
            semanticContext: [],
          });
        },
      },
    ),
    undefined,
  );
  assert.equal(disabledCalls, 0);

  const sharedBudget = new OcclusionCompletionBudget(4);
  let calls = 0;
  const results = [];
  for (let index = 0; index < 5; index += 1) {
    const current = await fixture();
    results.push(
      await completeOccludedCandidate(
        { ...current.input, budget: sharedBudget },
        {
          async complete() {
            calls += 1;
            return providerReturning(current.completedCrop).complete({
              crop: current.input.crop,
              hiddenMask: current.input.visibleMask,
              protectedVisibleMask: current.input.visibleMask,
              semanticContext: [],
            });
          },
        },
      ),
    );
  }
  assert.equal(calls, 4);
  assert.equal(results.filter((result) => result !== undefined).length, 4);
  assert.equal(results[4], undefined);
  assert.throws(() => new OcclusionCompletionBudget(5), /zero through four/i);
});

test("composites only generated hidden pixels, locks visible RGBA, and records hashes", async () => {
  const { input, completedCrop, sourceRgba } = await fixture();
  const result = await completeOccludedCandidate(
    input,
    providerReturning(completedCrop),
  );
  assert.ok(result);
  assert.equal(result.reviewRequired, true);
  assert.deepEqual(result.visibleMask, input.visibleMask);
  assert.equal(result.provenance.kind, "composite");
  assert.equal(
    result.provenance.sourceCropSha256,
    createHash("sha256").update(input.crop).digest("hex"),
  );
  assert.equal(
    result.provenance.visibleMaskSha256,
    createHash("sha256").update(input.visibleMask).digest("hex"),
  );
  assert.equal(
    result.provenance.generatedMaskSha256,
    createHash("sha256").update(result.generatedMask).digest("hex"),
  );
  assert.equal(
    result.provenance.assetSha256,
    createHash("sha256").update(result.image).digest("hex"),
  );
  assert.equal(result.provenance.modelId, "provider-model");
  assert.equal(
    result.provenance.taskIdSha256,
    createHash("sha256").update("provider-task").digest("hex"),
  );
  assert.equal("taskId" in result.provenance, false);
  assert.deepEqual(result.provenance.sanitizedProviderMetadata, {
    status: "succeeded",
    attempts: 1,
  });

  const output = await sharp(result.image).ensureAlpha().raw().toBuffer();
  for (const [x, y] of [
    [1, 2],
    [2, 2],
    [6, 2],
    [7, 2],
  ] as const) {
    const offset = pixelOffset(x, y);
    assert.deepEqual(
      output.subarray(offset, offset + 4),
      sourceRgba.subarray(offset, offset + 4),
      `visible pixel ${x},${y} must remain byte-identical`,
    );
  }
  const generatedAlpha = await alphaOf(result.generatedMask);
  assert.equal(generatedAlpha[2 * WIDTH + 4], 255);
  assert.equal(output[pixelOffset(0, 0) + 3], 0);
});

test("rejects non-JSON provider metadata instead of persisting it", async () => {
  const { input, completedCrop } = await fixture();
  const result = await completeOccludedCandidate(input, {
    async complete() {
      return {
        image: completedCrop,
        modelId: "provider-model",
        taskId: "provider-task",
        sanitizedMetadata: { callback: () => undefined },
      };
    },
  });
  assert.equal(result, undefined);
});

test("redacts provider credentials and signed URLs at the generic metadata boundary", async () => {
  const { input, completedCrop } = await fixture();
  const result = await completeOccludedCandidate(input, {
    async complete() {
      return {
        image: completedCrop,
        modelId: "provider-model",
        taskId: "provider-task",
        sanitizedMetadata: {
          authorization: "Bearer secret-token-value",
          requestId: "opaque-request-id-canary-123456789",
          opaqueReference: "QW5hbHlzaXNPcGFxdWVUcmFjaW5nVG9rZW4xMjM0NTY=",
          status: "succeeded",
          resultUrl:
            "https://example.invalid/result.png?Signature=secret-signature",
        },
      };
    },
  });
  assert.ok(result);
  assert.equal(result.provenance.kind, "composite");
  assert.doesNotMatch(
    JSON.stringify(result.provenance),
    /secret-token-value|secret-signature|Signature|opaque-request-id-canary|QW5hbHlzaXNPcGFxdWU/,
  );
  assert.equal(
    result.provenance.taskIdSha256,
    createHash("sha256").update("provider-task").digest("hex"),
  );
  assert.deepEqual(result.provenance.sanitizedProviderMetadata, {
    status: "succeeded",
  });
});

test("malformed provider envelopes consume budget and return no layer", async () => {
  const current = await fixture();
  const malformedEnvelopes: unknown[] = [
    undefined,
    null,
    {
      image: "not-a-buffer",
      modelId: "provider-model",
      taskId: "provider-task",
      sanitizedMetadata: {},
    },
    {
      image: current.completedCrop,
      modelId: "",
      taskId: "provider-task",
      sanitizedMetadata: {},
    },
    {
      image: current.completedCrop,
      modelId: "provider-model",
      taskId: "",
      sanitizedMetadata: {},
    },
  ];

  for (const malformed of malformedEnvelopes) {
    const attempt = await fixture();
    const budget = new OcclusionCompletionBudget(1);
    let malformedCalls = 0;
    const provider = {
      async complete() {
        malformedCalls += 1;
        return malformed;
      },
    } as unknown as OcclusionCompletionProvider;
    assert.equal(
      await completeOccludedCandidate(
        { ...attempt.input, budget },
        provider,
      ),
      undefined,
    );
    assert.equal(malformedCalls, 1);

    let validCalls = 0;
    assert.equal(
      await completeOccludedCandidate(
        { ...attempt.input, budget },
        {
          async complete() {
            validCalls += 1;
            return providerReturning(attempt.completedCrop).complete({
              crop: attempt.input.crop,
              hiddenMask: attempt.input.visibleMask,
              protectedVisibleMask: attempt.input.visibleMask,
              semanticContext: [],
            });
          },
        },
      ),
      undefined,
    );
    assert.equal(
      validCalls,
      0,
      "the malformed started call must consume budget",
    );
  }
});
