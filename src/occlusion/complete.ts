import { createHash } from "node:crypto";

import sharp from "sharp";
import { z } from "zod";

import { sanitizeProviderRecording } from "../recording.js";
import type {
  CompletedCandidate,
  OcclusionCompletionInput,
  OcclusionCompletionProvider,
} from "./contracts.js";

export type {
  CompletedCandidate,
  OcclusionCompletionInput,
  OcclusionCompletionProvider,
} from "./contracts.js";

const MASK_FOREGROUND_ALPHA = 16;

type Raster = {
  width: number;
  height: number;
  rgba: Buffer;
};

type ContactAxis = "horizontal" | "vertical";

type HiddenEvidence = {
  mask: Uint8Array;
  components: Array<{
    pixels: number[];
    axes: Set<ContactAxis>;
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

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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
  return (
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

function contactAxes(
  pixels: readonly number[],
  visible: Uint8Array,
  width: number,
  height: number,
): Set<ContactAxis> {
  let left = false;
  let right = false;
  let top = false;
  let bottom = false;
  for (const index of pixels) {
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0 && visible[index - 1] !== 0) left = true;
    if (x + 1 < width && visible[index + 1] !== 0) right = true;
    if (y > 0 && visible[index - width] !== 0) top = true;
    if (y + 1 < height && visible[index + width] !== 0) bottom = true;
  }
  const axes = new Set<ContactAxis>();
  if (left && right) axes.add("horizontal");
  if (top && bottom) axes.add("vertical");
  return axes;
}

function deriveHiddenEvidence(
  visible: Uint8Array,
  occluder: Uint8Array,
  width: number,
  height: number,
): HiddenEvidence | undefined {
  const possible = Uint8Array.from(occluder, (value, index) =>
    value !== 0 && visible[index] === 0 ? 255 : 0,
  );
  const acceptedComponents = connectedComponents(possible, width, height)
    .map((pixels) => ({
      pixels,
      axes: contactAxes(pixels, visible, width, height),
    }))
    .filter(({ axes }) => axes.size > 0);
  if (acceptedComponents.length === 0) return undefined;
  const mask = new Uint8Array(possible.length);
  for (const { pixels } of acceptedComponents) {
    for (const index of pixels) mask[index] = 255;
  }
  return { mask, components: acceptedComponents };
}

function changedPixel(left: Buffer, right: Buffer, index: number): boolean {
  const offset = index * 4;
  return (
    left[offset] !== right[offset] ||
    left[offset + 1] !== right[offset + 1] ||
    left[offset + 2] !== right[offset + 2] ||
    left[offset + 3] !== right[offset + 3]
  );
}

function bridgesRequiredAxes(
  generated: Uint8Array,
  visible: Uint8Array,
  evidence: HiddenEvidence,
  width: number,
  height: number,
): boolean {
  for (const { pixels, axes } of evidence.components) {
    const generatedPixels = pixels.filter((index) => generated[index] !== 0);
    if (generatedPixels.length === 0) return false;
    const generatedAxes = contactAxes(generatedPixels, visible, width, height);
    for (const axis of axes) {
      if (!generatedAxes.has(axis)) return false;
    }
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
  const occlusion = input.candidate.occlusion;
  if (occlusion === undefined || occlusion.occluderIds.length === 0) {
    return undefined;
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) return undefined;

  let crop: Raster;
  let visible: Uint8Array;
  let evidence: HiddenEvidence;
  try {
    crop = await decodeRgba(input.crop);
    if (!isCandidateCrop(input, crop.width, crop.height)) return undefined;
    visible = await decodeMask(input.visibleMask, crop.width, crop.height);
    const occluder = new Uint8Array(visible.length);
    for (const occluderId of occlusion.occluderIds) {
      const mask = input.occluderMasks.get(occluderId);
      if (mask === undefined) return undefined;
      const decoded = await decodeMask(mask, crop.width, crop.height);
      for (let index = 0; index < occluder.length; index += 1) {
        if (decoded[index] !== 0) occluder[index] = 255;
      }
    }
    const derived = deriveHiddenEvidence(visible, occluder, crop.width, crop.height);
    if (derived === undefined) return undefined;
    evidence = derived;
  } catch {
    return undefined;
  }

  if (!input.budget.tryAcquire()) return undefined;
  const hiddenMask = await grayscaleMaskPng(evidence.mask, crop.width, crop.height);

  let completion: Awaited<ReturnType<OcclusionCompletionProvider["complete"]>>;
  try {
    completion = await callWithTimeout(
      provider.complete({
        crop: input.crop,
        hiddenMask,
        protectedVisibleMask: input.visibleMask,
        semanticContext: [...input.semanticContext],
      }),
      input.timeoutMs,
    );
  } catch {
    return undefined;
  }

  if (completion.modelId.length === 0 || completion.taskId.length === 0) return undefined;
  let sanitizedMetadata: z.infer<ReturnType<typeof z.json>>;
  try {
    const metadata = z
      .json()
      .parse(sanitizeProviderRecording(completion.sanitizedMetadata, "").payload);
    sanitizedMetadata = metadata;
  } catch {
    return undefined;
  }

  let providerImage: Raster;
  try {
    providerImage = await decodeRgba(completion.image);
  } catch {
    return undefined;
  }
  if (providerImage.width !== crop.width || providerImage.height !== crop.height) {
    return undefined;
  }

  const generated = new Uint8Array(visible.length);
  for (let index = 0; index < visible.length; index += 1) {
    const changed = changedPixel(crop.rgba, providerImage.rgba, index);
    if (changed && visible[index] !== 0) return undefined;
    if (changed && evidence.mask[index] === 0) return undefined;
    if (changed && providerImage.rgba[index * 4 + 3]! >= MASK_FOREGROUND_ALPHA) {
      generated[index] = 255;
    }
  }
  if (
    !bridgesRequiredAxes(generated, visible, evidence, crop.width, crop.height) ||
    !oneContinuousContour(visible, generated, crop.width, crop.height)
  ) {
    return undefined;
  }

  const composite = Buffer.alloc(crop.rgba.length);
  for (let index = 0; index < visible.length; index += 1) {
    const offset = index * 4;
    if (visible[index] !== 0) {
      crop.rgba.copy(composite, offset, offset, offset + 4);
    } else if (generated[index] !== 0) {
      providerImage.rgba.copy(composite, offset, offset, offset + 4);
    }
  }
  const image = await sharp(composite, {
    raw: { width: crop.width, height: crop.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const generatedMask = await alphaMaskPng(generated, crop.width, crop.height);

  return {
    image,
    visibleMask: input.visibleMask,
    generatedMask,
    reviewRequired: true,
    provenance: {
      kind: "composite",
      sourceCropSha256: sha256(input.crop),
      visibleMaskSha256: sha256(input.visibleMask),
      generatedMaskSha256: sha256(generatedMask),
      assetSha256: sha256(image),
      modelId: completion.modelId,
      taskId: completion.taskId,
      sanitizedProviderMetadata: sanitizedMetadata,
    },
  };
}
