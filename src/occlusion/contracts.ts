import type { AssetProvenance } from "../contracts.js";
import type { SemanticCandidate } from "../scene/plan.js";

export type OcclusionCompletionProvider = {
  ownsTimeout?: boolean;
  complete(request: {
    crop: Buffer;
    hiddenMask: Buffer;
    protectedVisibleMask: Buffer;
    semanticContext: string[];
  }): Promise<{
    image: Buffer;
    modelId: string;
    taskId: string;
    sanitizedMetadata: unknown;
  }>;
};

export type OcclusionCompletionLimit = {
  tryAcquire(): boolean;
};

export type OcclusionCompletionInput = {
  candidate: Pick<SemanticCandidate, "bbox" | "occlusion">;
  canvas: { width: number; height: number };
  cropBounds: { x: number; y: number; width: number; height: number };
  crop: Buffer;
  visibleMask: Buffer;
  occluderMasks: ReadonlyMap<string, Buffer>;
  semanticContext: string[];
  budget: OcclusionCompletionLimit;
  timeoutMs: number;
};

export type CompletedCandidate = {
  image: Buffer;
  visibleMask: Buffer;
  generatedMask: Buffer;
  reviewRequired: true;
  provenance: AssetProvenance;
};
