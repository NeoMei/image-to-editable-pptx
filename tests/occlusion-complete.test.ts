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

const WIDTH = 9;
const HEIGHT = 5;

function pixelOffset(x: number, y: number): number {
  return (y * WIDTH + x) * 4;
}

async function pngFromRgba(rgba: Buffer): Promise<Buffer> {
  return sharp(rgba, {
    raw: { width: WIDTH, height: HEIGHT, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function maskPng(
  points: ReadonlyArray<readonly [number, number]>,
): Promise<Buffer> {
  const mask = Buffer.alloc(WIDTH * HEIGHT);
  for (const [x, y] of points) mask[y * WIDTH + x] = 255;
  return sharp(mask, {
    raw: { width: WIDTH, height: HEIGHT, channels: 1 },
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

test("sends only the padded candidate crop and crop-sized masks", async () => {
  const { input, completedCrop } = await fixture();
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
  assert.deepEqual(capturedRequest.crop, input.crop);
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
  assert.equal(result.provenance.taskId, "provider-task");
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
          resultUrl:
            "https://example.invalid/result.png?Signature=secret-signature",
        },
      };
    },
  });
  assert.ok(result);
  assert.doesNotMatch(
    JSON.stringify(result.provenance),
    /secret-token-value|secret-signature|Signature/,
  );
});
