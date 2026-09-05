import { createHash } from "node:crypto";

import sharp from "sharp";
import { z } from "zod";

import { sanitizeProviderMetadata } from "../recording.js";
import { RoutingTerminalError } from "../providers/routing.js";
import type {
  CompletedCandidate,
  CompletionOutcome,
  OcclusionCompletionInput,
  OcclusionCompletionProvider,
} from "./contracts.js";
import { assertValidCompletionOutcome } from "./diagnostics.js";
import {
  assessHiddenCandidate,
  qualifyAppearance,
} from "./quality.js";
import { clearHiddenPixels } from "./request.js";

export type {
  CompletedCandidate,
  CompletionOutcome,
  CompletionReason,
  OcclusionCompletionInput,
  OcclusionCompletionProvider,
} from "./contracts.js";

const MASK_FOREGROUND_ALPHA = 16;
const CROP_CONTEXT_CANVAS_SCALE_DIVISOR = 64;
const CROP_CONTEXT_CANDIDATE_SCALE_DIVISOR = 4;
const CONTACT_ALIGNMENT_CANDIDATE_SCALE_DIVISOR = 16;

type Raster = {
  width: number;
  height: number;
  rgba: Buffer;
};

type ContactPair = {
  first: number;
  second: number;
};

type HiddenEvidence = {
  mask: Uint8Array;
  components: Array<{
    pixels: number[];
    pairs: ContactPair[];
  }>;
};

export class OcclusionCompletionBudget {
  readonly limit: number;
  #used = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 0 || limit > 4) {
      throw new RangeError(
        "Occlusion completion limit must be an integer from zero through four",
      );
    }
    this.limit = limit;
  }

  tryAcquire(): boolean {
    if (this.#used >= this.limit) return false;
    this.#used += 1;
    return true;
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCropPadding(input: OcclusionCompletionInput): number {
  const shorterCanvasSide = Math.min(input.canvas.width, input.canvas.height);
  const shorterCandidateSide = Math.min(
    input.candidate.bbox.width,
    input.candidate.bbox.height,
  );
  const canvasScale = Math.max(
    1,
    Math.round(shorterCanvasSide / CROP_CONTEXT_CANVAS_SCALE_DIVISOR),
  );
  const candidateScale = Math.max(
    1,
    Math.floor(
      shorterCandidateSide / CROP_CONTEXT_CANDIDATE_SCALE_DIVISOR,
    ),
  );
  return Math.min(canvasScale, candidateScale);
}

function contactAlignmentTolerance(input: OcclusionCompletionInput): number {
  const shorterCandidateSide = Math.min(
    input.candidate.bbox.width,
    input.candidate.bbox.height,
  );
  return Math.max(
    1,
    Math.min(
      canonicalCropPadding(input),
      Math.round(
        shorterCandidateSide / CONTACT_ALIGNMENT_CANDIDATE_SCALE_DIVISOR,
      ),
    ),
  );
}

function isCandidateCrop(
  input: OcclusionCompletionInput,
  width: number,
  height: number,
): boolean {
  const { canvas, cropBounds, candidate } = input;
  if (
    !Number.isInteger(canvas.width) ||
    canvas.width <= 0 ||
    !Number.isInteger(canvas.height) ||
    canvas.height <= 0 ||
    !Number.isInteger(cropBounds.x) ||
    cropBounds.x < 0 ||
    !Number.isInteger(cropBounds.y) ||
    cropBounds.y < 0 ||
    !Number.isInteger(cropBounds.width) ||
    cropBounds.width !== width ||
    !Number.isInteger(cropBounds.height) ||
    cropBounds.height !== height ||
    cropBounds.x + width > canvas.width ||
    cropBounds.y + height > canvas.height ||
    (cropBounds.x === 0 &&
      cropBounds.y === 0 &&
      width === canvas.width &&
      height === canvas.height)
  ) {
    return false;
  }
  const bbox = candidate.bbox;
  if (
    !(
      Number.isFinite(bbox.x) &&
      Number.isFinite(bbox.y) &&
      Number.isFinite(bbox.width) &&
      bbox.width > 0 &&
      Number.isFinite(bbox.height) &&
      bbox.height > 0 &&
      bbox.x >= cropBounds.x &&
      bbox.y >= cropBounds.y &&
      bbox.x + bbox.width <= cropBounds.x + cropBounds.width &&
      bbox.y + bbox.height <= cropBounds.y + cropBounds.height
    )
  ) {
    return false;
  }
  const padding = canonicalCropPadding(input);
  const canonical = {
    left: Math.max(0, Math.floor(bbox.x) - padding),
    top: Math.max(0, Math.floor(bbox.y) - padding),
    right: Math.min(canvas.width, Math.ceil(bbox.x + bbox.width) + padding),
    bottom: Math.min(canvas.height, Math.ceil(bbox.y + bbox.height) + padding),
  };
  return (
    cropBounds.x >= canonical.left &&
    cropBounds.y >= canonical.top &&
    cropBounds.x + cropBounds.width <= canonical.right &&
    cropBounds.y + cropBounds.height <= canonical.bottom
  );
}

async function decodeRgba(image: Buffer): Promise<Raster> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width <= 0 || info.height <= 0 || info.channels !== 4) {
    throw new Error("Occlusion crop must decode to non-empty RGBA pixels");
  }
  return { width: info.width, height: info.height, rgba: data };
}

async function decodeMask(
  mask: Buffer,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const { data, info } = await sharp(mask)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) {
    throw new Error("Occlusion mask dimensions must match the candidate crop");
  }
  const alpha = new Uint8Array(width * height);
  for (let index = 0; index < alpha.length; index += 1) {
    const offset = index * info.channels;
    const value =
      info.channels === 1 || info.channels === 3
        ? data[offset]!
        : data[offset + info.channels - 1]!;
    alpha[index] = value >= MASK_FOREGROUND_ALPHA ? 255 : 0;
  }
  return alpha;
}

function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): number[][] {
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: number[][] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue;
    const component: number[] = [];
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++]!;
      component.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
            continue;
          }
          const next = nextY * width + nextX;
          if (mask[next] === 0 || visited[next] === 1) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    components.push(component);
  }
  return components;
}

function isAdjacentToComponent(
  index: number,
  component: ReadonlySet<number>,
  width: number,
  height: number,
): boolean {
  const x = index % width;
  const y = Math.floor(index / width);
  return (
    (x > 0 && component.has(index - 1)) ||
    (x + 1 < width && component.has(index + 1)) ||
    (y > 0 && component.has(index - width)) ||
    (y + 1 < height && component.has(index + width))
  );
}

function hasVisibleContinuation(
  contact: number,
  visibleComponents: readonly number[][],
  occluderComponent: ReadonlySet<number>,
  width: number,
  height: number,
): boolean {
  const visibleComponent = visibleComponents.find((pixels) =>
    pixels.includes(contact),
  );
  return (
    visibleComponent !== undefined &&
    visibleComponent.some(
      (index) =>
        index !== contact &&
        !isAdjacentToComponent(index, occluderComponent, width, height),
    )
  );
}

function contactPairs(
  pixels: readonly number[],
  visible: Uint8Array,
  width: number,
  height: number,
  alignmentTolerance: number,
  visibleComponents: readonly number[][],
): ContactPair[] {
  const contacts = {
    left: new Set<number>(),
    right: new Set<number>(),
    top: new Set<number>(),
    bottom: new Set<number>(),
  };
  for (const index of pixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0 && visible[index - 1] !== 0) contacts.left.add(index - 1);
    if (x + 1 < width && visible[index + 1] !== 0) {
      contacts.right.add(index + 1);
    }
    if (y > 0 && visible[index - width] !== 0) {
      contacts.top.add(index - width);
    }
    if (y + 1 < height && visible[index + width] !== 0) {
      contacts.bottom.add(index + width);
    }
  }
  const component = new Set(pixels);
  const hasContinuation = (index: number): boolean =>
    hasVisibleContinuation(
      index,
      visibleComponents,
      component,
      width,
      height,
    );
  const pairs: ContactPair[] = [];
  for (const left of contacts.left) {
    if (!hasContinuation(left)) continue;
    for (const right of contacts.right) {
      if (
        hasContinuation(right) &&
        Math.abs(Math.floor(left / width) - Math.floor(right / width)) <=
          alignmentTolerance
      ) {
        pairs.push({ first: left, second: right });
      }
    }
  }
  for (const top of contacts.top) {
    if (!hasContinuation(top)) continue;
    for (const bottom of contacts.bottom) {
      if (
        hasContinuation(bottom) &&
        Math.abs((top % width) - (bottom % width)) <= alignmentTolerance
      ) {
        pairs.push({ first: top, second: bottom });
      }
    }
  }
  return pairs;
}

function deriveHiddenEvidence(
  visible: Uint8Array,
  occluder: Uint8Array,
  width: number,
  height: number,
  alignmentTolerance: number,
): HiddenEvidence | undefined {
  const possible = Uint8Array.from(occluder, (value, index) =>
    value !== 0 && visible[index] === 0 ? 255 : 0,
  );
  const visibleComponents = connectedComponents(visible, width, height);
  const acceptedComponents = connectedComponents(possible, width, height)
    .map((pixels) => ({
      pixels,
      pairs: contactPairs(
        pixels,
        visible,
        width,
        height,
        alignmentTolerance,
        visibleComponents,
      ),
    }))
    .filter(({ pairs }) => pairs.length > 0);
  if (acceptedComponents.length === 0) return undefined;
  const mask = new Uint8Array(possible.length);
  for (const { pixels } of acceptedComponents) {
    for (const index of pixels) mask[index] = 255;
  }
  return { mask, components: acceptedComponents };
}

function touchesContact(
  generatedComponent: ReadonlySet<number>,
  contact: number,
  width: number,
  height: number,
): boolean {
  const x = contact % width;
  const y = Math.floor(contact / width);
  return (
    (x > 0 && generatedComponent.has(contact - 1)) ||
    (x + 1 < width && generatedComponent.has(contact + 1)) ||
    (y > 0 && generatedComponent.has(contact - width)) ||
    (y + 1 < height && generatedComponent.has(contact + width))
  );
}

function bridgesRequiredContacts(
  generated: Uint8Array,
  evidence: HiddenEvidence,
  width: number,
  height: number,
): boolean {
  for (const { pixels, pairs } of evidence.components) {
    const componentMask = new Uint8Array(generated.length);
    for (const index of pixels) componentMask[index] = generated[index]!;
    const generatedComponents = connectedComponents(
      componentMask,
      width,
      height,
    ).map((component) => new Set(component));
    const bridgesOnePair = pairs.some(({ first, second }) =>
      generatedComponents.some(
        (component) =>
          touchesContact(component, first, width, height) &&
          touchesContact(component, second, width, height),
      ),
    );
    if (!bridgesOnePair) return false;
  }
  return true;
}

function oneContinuousContour(
  visible: Uint8Array,
  generated: Uint8Array,
  width: number,
  height: number,
): boolean {
  const combined = Uint8Array.from(visible, (value, index) =>
    value !== 0 || generated[index] !== 0 ? 255 : 0,
  );
  return connectedComponents(combined, width, height).length === 1;
}

async function grayscaleMaskPng(
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp(mask, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function alphaMaskPng(
  mask: Uint8Array,
  width: number,
  height: number,
): Promise<Buffer> {
  const rgba = Buffer.alloc(mask.length * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 255;
    rgba[offset + 2] = 255;
    rgba[offset + 3] = mask[index]!;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function callWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Occlusion completion timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function completeOccludedCandidate(
  input: OcclusionCompletionInput,
  provider: OcclusionCompletionProvider,
): Promise<CompletedCandidate | undefined> {
  const outcome = await evaluateOccludedCandidate(input, provider);
  return outcome.status === "accepted" ? outcome.artifact : undefined;
}

function checkedOutcome(outcome: CompletionOutcome): CompletionOutcome {
  assertValidCompletionOutcome(outcome);
  return outcome;
}

function contactsFromEvidence(evidence: HiddenEvidence): number[] {
  const contacts = new Set<number>();
  for (const component of evidence.components) {
    for (const pair of component.pairs) {
      contacts.add(pair.first);
      contacts.add(pair.second);
    }
  }
  return [...contacts];
}

function finalInvariantsHold(input: {
  original: Raster;
  returned: Raster;
  visible: Uint8Array;
  generated: Uint8Array;
  hidden: Uint8Array;
  composite: Buffer;
}): boolean {
  const { original, returned, visible, generated, hidden, composite } = input;
  const pixelCount = original.width * original.height;
  if (
    !Number.isSafeInteger(pixelCount) ||
    original.rgba.length !== pixelCount * 4 ||
    returned.width !== original.width ||
    returned.height !== original.height ||
    returned.rgba.length !== original.rgba.length ||
    visible.length !== pixelCount ||
    generated.length !== pixelCount ||
    hidden.length !== pixelCount ||
    composite.length !== original.rgba.length
  ) return false;

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const isVisible = visible[index]! >= MASK_FOREGROUND_ALPHA;
    const isGenerated = generated[index]! >= MASK_FOREGROUND_ALPHA;
    if (isVisible && isGenerated) return false;
    if (isGenerated && hidden[index]! < MASK_FOREGROUND_ALPHA) return false;
    if (
      isVisible &&
      !composite.subarray(offset, offset + 4)
        .equals(original.rgba.subarray(offset, offset + 4))
    ) return false;
    if (!isVisible && !isGenerated && composite[offset + 3] !== 0) return false;
  }
  return oneContinuousContour(
    visible,
    generated,
    original.width,
    original.height,
  );
}

export async function evaluateOccludedCandidate(
  input: OcclusionCompletionInput,
  provider: OcclusionCompletionProvider,
): Promise<CompletionOutcome> {
  const occlusion = input.candidate.occlusion;
  if (occlusion === undefined || occlusion.occluderIds.length === 0) {
    return checkedOutcome({ status: "skipped", reason: "geometry" });
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    return checkedOutcome({ status: "skipped", reason: "disabled" });
  }

  let crop: Raster;
  let visible: Uint8Array;
  let occluder: Uint8Array;
  let protectedVisibleMask = input.visibleMask;
  let evidence: HiddenEvidence;
  try {
    crop = await decodeRgba(input.crop);
    if (!isCandidateCrop(input, crop.width, crop.height)) {
      return checkedOutcome({ status: "rejected", reason: "geometry" });
    }
    visible = await decodeMask(input.visibleMask, crop.width, crop.height);
    occluder = new Uint8Array(visible.length);
    for (const occluderId of occlusion.occluderIds) {
      const mask = input.occluderMasks.get(occluderId);
      if (mask === undefined) {
        return checkedOutcome({ status: "rejected", reason: "geometry" });
      }
      const decoded = await decodeMask(mask, crop.width, crop.height);
      for (let index = 0; index < occluder.length; index += 1) {
        if (decoded[index] !== 0) occluder[index] = 255;
      }
    }
    // Foreground extraction can include the front object in the rear crop.
    // Only accepted occluders may remove those pixels from the visible support.
    let hasOverlap = false;
    for (let index = 0; index < visible.length; index += 1) {
      if (occluder[index] !== 0 && visible[index] !== 0) {
        visible[index] = 0;
        hasOverlap = true;
      }
    }
    if (hasOverlap) {
      protectedVisibleMask = await alphaMaskPng(visible, crop.width, crop.height);
    }
    const derived = deriveHiddenEvidence(
      visible,
      occluder,
      crop.width,
      crop.height,
      contactAlignmentTolerance(input),
    );
    if (derived === undefined) {
      return checkedOutcome({ status: "rejected", reason: "contour_mismatch" });
    }
    evidence = derived;
  } catch (error) {
    if (error instanceof RoutingTerminalError) throw error;
    return checkedOutcome({ status: "rejected", reason: "geometry" });
  }

  const appearance = qualifyAppearance({
    source: crop,
    visible,
    hidden: evidence.mask,
    occluder,
    contacts: contactsFromEvidence(evidence),
  });
  if (!appearance.ok) {
    return checkedOutcome({ status: "rejected", reason: appearance.reason });
  }

  if (!input.budget.tryAcquire()) {
    return checkedOutcome({ status: "skipped", reason: "disabled" });
  }
  const hiddenMask = await grayscaleMaskPng(
    evidence.mask,
    crop.width,
    crop.height,
  );
  const clearedCrop = await sharp(
    clearHiddenPixels(crop, evidence.mask),
    { raw: { width: crop.width, height: crop.height, channels: 4 } },
  )
    .png()
    .toBuffer();

  let completion: {
    image: Buffer;
    modelId: string;
    taskId: string;
    sanitizedMetadata: unknown;
  };
  let sanitizedMetadata: z.infer<ReturnType<typeof z.json>>;
  try {
    const providerPromise = provider.complete({
      crop: clearedCrop,
      hiddenMask,
      protectedVisibleMask,
      semanticContext: [...input.semanticContext],
    });
    const providerResult: unknown = provider.ownsTimeout === true
      ? await providerPromise
      : await callWithTimeout(providerPromise, input.timeoutMs);
    if (
      typeof providerResult !== "object" ||
      providerResult === null ||
      !("image" in providerResult) ||
      !Buffer.isBuffer(providerResult.image) ||
      !("modelId" in providerResult) ||
      typeof providerResult.modelId !== "string" ||
      providerResult.modelId.trim().length === 0 ||
      !("taskId" in providerResult) ||
      typeof providerResult.taskId !== "string" ||
      providerResult.taskId.trim().length === 0 ||
      !("sanitizedMetadata" in providerResult)
    ) {
      return checkedOutcome({ status: "rejected", reason: "invalid_metadata" });
    }
    completion = {
      image: providerResult.image,
      modelId: providerResult.modelId,
      taskId: providerResult.taskId,
      sanitizedMetadata: providerResult.sanitizedMetadata,
    };
  } catch (error) {
    if (error instanceof RoutingTerminalError) throw error;
    return checkedOutcome({ status: "skipped", reason: "provider_failure" });
  }
  try {
    sanitizedMetadata = z.json().parse(
      sanitizeProviderMetadata(completion.sanitizedMetadata),
    );
  } catch {
    return checkedOutcome({ status: "rejected", reason: "invalid_metadata" });
  }

  let providerImage: Raster;
  try {
    providerImage = await decodeRgba(completion.image);
  } catch {
    return checkedOutcome({ status: "rejected", reason: "geometry" });
  }
  if (providerImage.width !== crop.width || providerImage.height !== crop.height) {
    return checkedOutcome({ status: "rejected", reason: "geometry" });
  }

  const assessed = assessHiddenCandidate({
    source: crop,
    returned: providerImage,
    visible,
    hidden: evidence.mask,
    occluder,
    contacts: contactsFromEvidence(evidence),
    profile: appearance.profile,
  });
  if (!assessed.ok) {
    return checkedOutcome({
      status: "rejected",
      reason: assessed.reason,
      metrics: assessed.metrics,
    });
  }
  const { generated, metrics } = assessed;
  if (
    !bridgesRequiredContacts(generated, evidence, crop.width, crop.height) ||
    !oneContinuousContour(visible, generated, crop.width, crop.height)
  ) {
    return checkedOutcome({
      status: "rejected",
      reason: "contour_mismatch",
      metrics,
    });
  }

  const composite = Buffer.alloc(crop.rgba.length);
  for (let index = 0; index < visible.length; index += 1) {
    const offset = index * 4;
    if (visible[index]! >= 16) {
      crop.rgba.copy(composite, offset, offset, offset + 4);
    } else if (generated[index]! >= 16) {
      providerImage.rgba.copy(composite, offset, offset, offset + 4);
    }
  }
  if (!finalInvariantsHold({
    original: crop,
    returned: providerImage,
    visible,
    generated,
    hidden: evidence.mask,
    composite,
  })) {
    return checkedOutcome({
      status: "rejected",
      reason: "invariant_failure",
      metrics,
    });
  }
  const image = await sharp(composite, {
    raw: { width: crop.width, height: crop.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const generatedMask = await alphaMaskPng(generated, crop.width, crop.height);

  return checkedOutcome({
    status: "accepted",
    metrics,
    artifact: {
      image,
      visibleMask: protectedVisibleMask,
      generatedMask,
      reviewRequired: true,
      provenance: {
        kind: "composite",
        sourceCropSha256: sha256(input.crop),
        visibleMaskSha256: sha256(protectedVisibleMask),
        generatedMaskSha256: sha256(generatedMask),
        assetSha256: sha256(image),
        modelId: completion.modelId,
        taskIdSha256: sha256(completion.taskId),
        sanitizedProviderMetadata: sanitizedMetadata,
      },
    },
  });
}
