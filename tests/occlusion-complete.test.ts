import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import {
  OcclusionCompletionBudget,
  completeOccludedCandidate,
  evaluateOccludedCandidate,
  type OcclusionCompletionInput,
  type OcclusionCompletionProvider,
} from "../src/occlusion/complete.js";
import { createCountedCompletionProvider } from "../src/pipeline.js";
import { RoutingTerminalError } from "../src/providers/routing.js";
import { sourceLockedOcclusionFixture } from "./fixtures/occlusion/source-locked.js";

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

async function supportOf(image: Buffer): Promise<Buffer> {
  const metadata = await sharp(image).metadata();
  return (metadata.hasAlpha
    ? sharp(image).extractChannel("alpha")
    : sharp(image).greyscale())
    .raw()
    .toBuffer();
}

async function pngFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function qualifiedFixture(): Promise<{
  input: OcclusionCompletionInput;
  valid: Buffer;
  originalRgba: Buffer;
  hidden: Uint8Array;
  visible: Uint8Array;
  width: number;
  height: number;
}> {
  const current = await sourceLockedOcclusionFixture();
  const { width, height } = current.geometry.canvas;
  const cropBounds = { x: 10, y: 10, width, height };
  return {
    input: {
      candidate: {
        bbox: {
          x: cropBounds.x + current.geometry.rear.x,
          y: cropBounds.y + current.geometry.rear.y,
          width: current.geometry.rear.width,
          height: current.geometry.rear.height,
        },
        occlusion: {
          occluderIds: ["front-node"],
          hiddenMaskRequired: true,
        },
      },
      canvas: { width: 320, height: 240 },
      cropBounds,
      crop: current.pngs.original,
      visibleMask: await pngFromMask(current.masks.visible, width, height),
      occluderMasks: new Map([
        ["front-node", await pngFromMask(current.masks.front, width, height)],
      ]),
      semanticContext: ["rear candidate continues behind accepted occluder"],
      budget: new OcclusionCompletionBudget(4),
      timeoutMs: 100,
    },
    valid: current.pngs.valid,
    originalRgba: current.rasters.original,
    hidden: current.masks.hidden,
    visible: current.masks.visible,
    width,
    height,
  };
}

test("source-locks visible bytes when accepted provider output changes every outside-hidden pixel", async () => {
  const current = await qualifiedFixture();
  const returned = await sharp(current.valid).ensureAlpha().raw().toBuffer();
  for (let index = 0; index < current.hidden.length; index += 1) {
    if (current.hidden[index]! < 16) {
      returned.set([255, 0, 255, 255], index * 4);
    }
  }
  const returnedPng = await pngFromRgba(returned, current.width, current.height);
  const returnedSnapshot = Buffer.from(returnedPng);

  const outcome = await evaluateOccludedCandidate(
    current.input,
    providerReturning(returnedPng),
  );

  assert.equal(outcome.status, "accepted");
  if (outcome.status !== "accepted") assert.fail("expected accepted completion");
  assert.equal(outcome.metrics.returnedOutsideChangedPixels, 688);
  assert.equal(outcome.metrics.returnedVisibleChangedPixels, 320);
  assert.equal(outcome.artifact.reviewRequired, true);
  assert.deepEqual(returnedPng, returnedSnapshot, "provider return must stay immutable");
  const [final, generatedMask, visibleMask] = await Promise.all([
    sharp(outcome.artifact.image).ensureAlpha().raw().toBuffer(),
    supportOf(outcome.artifact.generatedMask),
    supportOf(outcome.artifact.visibleMask),
  ]);
  for (let index = 0; index < current.visible.length; index += 1) {
    const offset = index * 4;
    const isVisible = visibleMask[index]! >= 16;
    const isGenerated = generatedMask[index]! >= 16;
    assert.equal(isVisible && isGenerated, false, `supports overlap at ${index}`);
    if (isGenerated) {
      assert.ok(current.hidden[index]! >= 16, `generated support escapes hidden evidence at ${index}`);
    }
    if (isVisible) {
      assert.deepEqual(
        final.subarray(offset, offset + 4),
        current.originalRgba.subarray(offset, offset + 4),
        `visible pixel ${index} must remain source-identical`,
      );
    } else if (!isGenerated) {
      assert.equal(final[offset + 3], 0, `outside support union ${index} must be transparent`);
    }
    assert.notDeepEqual([...final.subarray(offset, offset + 4)], [255, 0, 255, 255]);
  }
});

test("rejects bad hidden content after one provider request", async () => {
  const current = await qualifiedFixture();
  const retainedFront = (await sourceLockedOcclusionFixture()).pngs.retainedFront;
  let calls = 0;
  const outcome = await evaluateOccludedCandidate(current.input, {
    async complete(request) {
      calls += 1;
      return providerReturning(retainedFront).complete(request);
    },
  });
  assert.equal(calls, 1);
  assert.equal(outcome.status, "rejected");
  if (outcome.status !== "rejected") assert.fail("expected quality rejection");
  assert.equal(outcome.reason, "residual_occluder");
});

test("does not acquire budget or call a provider when source appearance is unqualified", async () => {
  const current = await qualifiedFixture();
  const sparse = await sourceLockedOcclusionFixture();
  let acquisitions = 0;
  let calls = 0;
  const outcome = await evaluateOccludedCandidate(
    {
      ...current.input,
      crop: sparse.pngs.sparseContextSource,
      budget: { tryAcquire() { acquisitions += 1; return true; } },
    },
    {
      async complete(request) {
        calls += 1;
        return providerReturning(current.valid).complete(request);
      },
    },
  );
  assert.equal(outcome.status, "rejected");
  if (outcome.status !== "rejected") assert.fail("expected source qualification rejection");
  assert.equal(outcome.reason, "insufficient_evidence");
  assert.equal(acquisitions, 0);
  assert.equal(calls, 0);
});

test("subtracts accepted occluders from a contaminated foreground mask", async () => {
  const current = await qualifiedFixture();
  const contaminated = Uint8Array.from(current.visible, (value, index) =>
    value >= 16 || current.hidden[index]! >= 16 ? 255 : 0,
  );
  let calls = 0;
  let protectedMask: Buffer | undefined;
  const result = await completeOccludedCandidate(
    {
      ...current.input,
      visibleMask: await pngFromMask(contaminated, current.width, current.height),
    },
    {
      async complete(request) {
        calls += 1;
        protectedMask = request.protectedVisibleMask;
        return providerReturning(current.valid).complete(request);
      },
    },
  );
  assert.equal(calls, 1);
  assert.ok(result);
  assert.deepEqual(result.visibleMask, protectedMask);
  const visibleRgba = await sharp(result.visibleMask).ensureAlpha().raw().toBuffer();
  const visible = Buffer.alloc(current.visible.length);
  for (let index = 0; index < visible.length; index += 1) {
    visible[index] = visibleRgba[index * 4 + 3]!;
  }
  assert.deepEqual(visible, Buffer.from(current.visible));
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

test("does not call a provider when an accepted occluder mask is missing", async () => {
  const current = await fixture();
  let calls = 0;
  const outcome = await evaluateOccludedCandidate(
    { ...current.input, occluderMasks: new Map() },
    {
      async complete(request) {
        calls += 1;
        return providerReturning(current.completedCrop).complete(request);
      },
    },
  );
  assert.equal(outcome.status, "rejected");
  if (outcome.status !== "rejected") assert.fail("expected missing-mask rejection");
  assert.equal(outcome.reason, "geometry");
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
  const current = await qualifiedFixture();
  const { input } = current;
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
        image: current.valid,
        modelId: "provider-model",
        taskId: "provider-task",
        sanitizedMetadata: { status: "succeeded" },
      };
    },
  });
  assert.ok(result);
  assert.equal(calls, 1);
  assert.ok(capturedRequest);
  const sourceHash = createHash("sha256").update(input.crop).digest("hex");
  const requestHash = createHash("sha256").update(capturedRequest.crop).digest("hex");
  assert.notEqual(requestHash, sourceHash);
  assert.equal(result.provenance.kind, "composite");
  if (result.provenance.kind !== "composite") assert.fail("expected composite provenance");
  assert.equal(result.provenance.sourceCropSha256, sourceHash);
  assert.notEqual(result.provenance.sourceCropSha256, requestHash);
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
      { width: current.width, height: current.height },
    );
    assert.notDeepEqual(
      { width: metadata.width, height: metadata.height },
      input.canvas,
      "the full slide must never be sent",
    );
  }
  const { data: hidden, info: hiddenInfo } = await sharp(
    capturedRequest.hiddenMask,
  )
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(hidden[(10 * current.width + 15) * hiddenInfo.channels], 255);
  assert.equal(
    hidden[0],
    0,
    "unrelated occluder geometry must not leak into the mask",
  );
  const cleared = await sharp(capturedRequest.crop).ensureAlpha().raw().toBuffer();
  assert.deepEqual(
    [...cleared.subarray(pixelOffset(15, 10, current.width), pixelOffset(15, 10, current.width) + 4)],
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    [...cleared.subarray(pixelOffset(4, 4, current.width), pixelOffset(4, 4, current.width) + 4)],
    [40, 100, 160, 255],
  );
});

test("rejects a disconnected completion", async () => {
  const current = await qualifiedFixture();
  const sourceLocked = await sourceLockedOcclusionFixture();
  const outcome = await evaluateOccludedCandidate(
    current.input,
    providerReturning(sourceLocked.pngs.disconnectedIsland),
  );
  assert.equal(outcome.status, "rejected");
  if (outcome.status !== "rejected") assert.fail("expected contour rejection");
  assert.equal(outcome.reason, "contour_mismatch");
});

test("provider failures and timeouts leave the original candidate in the background", async () => {
  const failed = await qualifiedFixture();
  const failedOutcome = await evaluateOccludedCandidate(failed.input, {
      async complete() {
        throw new Error("provider failed");
      },
    });
  assert.deepEqual(failedOutcome, {
    status: "skipped",
    reason: "provider_failure",
  });

  const timedOut = await qualifiedFixture();
  const timedOutOutcome = await evaluateOccludedCandidate(
      { ...timedOut.input, timeoutMs: 5 },
      {
        async complete() {
          return new Promise(() => undefined);
        },
      },
  );
  assert.deepEqual(timedOutOutcome, {
    status: "skipped",
    reason: "provider_failure",
  });
});

test("counted routed completion retains timeout ownership through candidate completion", async () => {
  const { input, valid } = await qualifiedFixture();
  let requests = 0;
  const provider = createCountedCompletionProvider({
    ownsTimeout: true,
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return providerReturning(valid).complete({
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
  const { input } = await qualifiedFixture();
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

test("exhausted configured completion APIs remain terminal instead of looking unconfigured", async () => {
  const { input } = await qualifiedFixture();
  const terminal = new RoutingTerminalError({
    sequence: 1,
    operation: "completion",
    outcome: "exhausted",
    selectedCandidate: undefined,
    selectedModel: undefined,
    attempts: [{ candidate: "api-openai", status: "auth_unavailable", disposition: "auth_unavailable" }],
  });
  await assert.rejects(completeOccludedCandidate(input, {
    ownsTimeout: true,
    async complete() { throw terminal; },
  }), terminal);
});

test("zero disables completion and a shared budget permits at most four calls", async () => {
  const disabled = await qualifiedFixture();
  let disabledCalls = 0;
  assert.equal(
    await completeOccludedCandidate(
      { ...disabled.input, budget: new OcclusionCompletionBudget(0) },
      {
        async complete() {
          disabledCalls += 1;
          return providerReturning(disabled.valid).complete({
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
    const current = await qualifiedFixture();
    results.push(
      await completeOccludedCandidate(
        { ...current.input, budget: sharedBudget },
        {
          async complete() {
            calls += 1;
            return providerReturning(current.valid).complete({
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
  const current = await qualifiedFixture();
  const { input } = current;
  const result = await completeOccludedCandidate(
    input,
    providerReturning(current.valid),
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
  for (let index = 0; index < current.visible.length; index += 1) {
    if (current.visible[index]! < 16) continue;
    const offset = index * 4;
    assert.deepEqual(output.subarray(offset, offset + 4),
      current.originalRgba.subarray(offset, offset + 4));
  }
  const generatedAlpha = await sharp(result.generatedMask).ensureAlpha().raw().toBuffer();
  assert.equal(generatedAlpha[(10 * current.width + 15) * 4 + 3], 255);
  assert.equal(output[pixelOffset(0, 0, current.width) + 3], 0);
});

test("rejects non-JSON provider metadata instead of persisting it", async () => {
  const { input, valid } = await qualifiedFixture();
  const outcome = await evaluateOccludedCandidate(input, {
    async complete() {
      return {
        image: valid,
        modelId: "provider-model",
        taskId: "provider-task",
        sanitizedMetadata: { callback: () => undefined },
      };
    },
  });
  assert.equal(outcome.status, "rejected");
  if (outcome.status !== "rejected") assert.fail("expected metadata rejection");
  assert.equal(outcome.reason, "invalid_metadata");
});

test("redacts provider credentials and signed URLs at the generic metadata boundary", async () => {
  const { input, valid } = await qualifiedFixture();
  const result = await completeOccludedCandidate(input, {
    async complete() {
      return {
        image: valid,
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
  const current = await qualifiedFixture();
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
      image: current.valid,
      modelId: "",
      taskId: "provider-task",
      sanitizedMetadata: {},
    },
    {
      image: current.valid,
      modelId: "provider-model",
      taskId: "",
      sanitizedMetadata: {},
    },
  ];

  for (const malformed of malformedEnvelopes) {
    const attempt = await qualifiedFixture();
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
            return providerReturning(attempt.valid).complete({
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
