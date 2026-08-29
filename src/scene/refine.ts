import type { BBox } from "../contracts.js";
import {
  CanvasSizeSchema,
  SceneGraphSchema,
  type CanvasSize,
  type SceneGraph,
  type SceneNode,
  type SceneRelation,
} from "./contracts.js";
import { createBBoxSchema } from "./geometry.js";

export type RefinementReason =
  | "compound"
  | "occlusion"
  | "conflicting-relations"
  | "incomplete-boundary";

export type RefinementRequest = {
  targetNodeIds: string[];
  crop: BBox;
  reason: RefinementReason;
};

export type RefinementResult = {
  graph: SceneGraph;
  requests: RefinementRequest[];
};

type RankedRequest = RefinementRequest & {
  confidence: number;
  normalizedArea: number;
};

const MAX_REFINEMENT_REQUESTS = 8;
const CROP_PADDING_RATIO = 0.05;
const EDGE_EPSILON = 1e-9;
const DUPLICATE_IOU_THRESHOLD = 0.8;

const REASON_SEVERITY: Readonly<Record<RefinementReason, number>> = {
  "conflicting-relations": 0,
  occlusion: 1,
  "incomplete-boundary": 2,
  compound: 3,
};

function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference =
      leftCodePoints[index]!.codePointAt(0)! - rightCodePoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function compareTargetIdTuples(
  left: readonly string[],
  right: readonly string[],
): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = compareCodePoints(left[index]!, right[index]!);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function isProtectedNode(node: SceneNode): boolean {
  return node.role === "background" || node.role === "text";
}

function intersectionOverUnion(left: BBox, right: BBox): number {
  const interLeft = Math.max(left.x, right.x);
  const interTop = Math.max(left.y, right.y);
  const interRight = Math.min(left.x + left.width, right.x + right.width);
  const interBottom = Math.min(left.y + left.height, right.y + right.height);
  const intersectionWidth = Math.max(0, interRight - interLeft);
  const intersectionHeight = Math.max(0, interBottom - interTop);
  const intersection = intersectionWidth * intersectionHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function deduplicateRefinedNodes(
  nodes: readonly SceneNode[],
  targetNodeIds: ReadonlySet<string>,
): { nodes: SceneNode[]; droppedIds: ReadonlySet<string> } {
  const ranked = [...nodes].sort(
    (left, right) =>
      Number(targetNodeIds.has(right.id)) - Number(targetNodeIds.has(left.id)) ||
      right.confidence - left.confidence ||
      compareCodePoints(left.id, right.id),
  );
  const kept: SceneNode[] = [];
  const droppedIds = new Set<string>();
  for (const candidate of ranked) {
    const duplicatesKeptNode = kept.some(
      (existing) =>
        intersectionOverUnion(existing.bbox, candidate.bbox) > DUPLICATE_IOU_THRESHOLD,
    );
    if (duplicatesKeptNode) {
      droppedIds.add(candidate.id);
    } else {
      kept.push(candidate);
    }
  }
  return { nodes: kept, droppedIds };
}

function unionNormalizedBBox(nodes: readonly SceneNode[]): SceneNode["bbox"] {
  const left = Math.min(...nodes.map(({ bbox }) => bbox.x));
  const top = Math.min(...nodes.map(({ bbox }) => bbox.y));
  const right = Math.max(...nodes.map(({ bbox }) => bbox.x + bbox.width));
  const bottom = Math.max(...nodes.map(({ bbox }) => bbox.y + bbox.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function paddedPixelCrop(
  nodes: readonly SceneNode[],
  canvas: CanvasSize,
): BBox {
  const bbox = unionNormalizedBBox(nodes);
  const left = Math.floor(bbox.x * canvas.width);
  const top = Math.floor(bbox.y * canvas.height);
  const right = Math.ceil((bbox.x + bbox.width) * canvas.width);
  const bottom = Math.ceil((bbox.y + bbox.height) * canvas.height);
  const paddingX = Math.max(1, Math.ceil((right - left) * CROP_PADDING_RATIO));
  const paddingY = Math.max(1, Math.ceil((bottom - top) * CROP_PADDING_RATIO));
  const paddedLeft = Math.max(0, left - paddingX);
  const paddedTop = Math.max(0, top - paddingY);
  const paddedRight = Math.min(canvas.width, right + paddingX);
  const paddedBottom = Math.min(canvas.height, bottom + paddingY);

  return createBBoxSchema(canvas).parse({
    x: paddedLeft,
    y: paddedTop,
    width: paddedRight - paddedLeft,
    height: paddedBottom - paddedTop,
  });
}

function canonicalTargetNodes(
  nodeById: ReadonlyMap<string, SceneNode>,
  ids: readonly string[],
): SceneNode[] {
  return [...new Set(ids)]
    .map((id) => nodeById.get(id))
    .filter((candidate): candidate is SceneNode =>
      candidate !== undefined && !isProtectedNode(candidate),
    )
    .sort((left, right) => compareCodePoints(left.id, right.id));
}

function normalizedOrder(relation: SceneRelation): [string, string] | undefined {
  if (relation.kind === "in-front-of") return [relation.from, relation.to];
  if (relation.kind === "behind") return [relation.to, relation.from];
  return undefined;
}

function isZIndexConflict(
  relation: SceneRelation,
  nodeById: ReadonlyMap<string, SceneNode>,
): boolean {
  const order = normalizedOrder(relation);
  if (order === undefined) return false;
  const front = nodeById.get(order[0]);
  const rear = nodeById.get(order[1]);
  return (
    front?.zIndex !== undefined &&
    rear?.zIndex !== undefined &&
    front.zIndex <= rear.zIndex
  );
}

export function selectRefinementRequests(
  graph: SceneGraph,
  canvas: CanvasSize,
  limit: number,
): RefinementRequest[] {
  SceneGraphSchema.parse(graph);
  const parsedGraph = graph;
  const owningCanvas = CanvasSizeSchema.parse(canvas);
  if (
    parsedGraph.canvas.width !== owningCanvas.width ||
    parsedGraph.canvas.height !== owningCanvas.height
  ) {
    throw new Error("Refinement canvas must match the scene graph canvas");
  }
  if (
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > MAX_REFINEMENT_REQUESTS
  ) {
    throw new Error("Refinement request limit must be an integer from 0 through 8");
  }
  if (limit === 0) return [];

  const nodeById = new Map(parsedGraph.nodes.map((candidate) => [candidate.id, candidate]));
  const rankedByTargets = new Map<string, RankedRequest>();

  function addCandidate(
    reason: RefinementReason,
    ids: readonly string[],
    relationConfidence?: number,
  ): void {
    const nodes = canonicalTargetNodes(nodeById, ids);
    if (nodes.length === 0) return;
    const targetNodeIds = nodes.map(({ id }) => id);
    const bbox = unionNormalizedBBox(nodes);
    const candidate: RankedRequest = {
      reason,
      targetNodeIds,
      crop: paddedPixelCrop(nodes, owningCanvas),
      confidence: Math.min(
        ...nodes.map(({ confidence }) => confidence),
        relationConfidence ?? 1,
      ),
      normalizedArea: bbox.width * bbox.height,
    };
    const key = targetNodeIds.join("\u0000");
    const existing = rankedByTargets.get(key);
    if (
      existing === undefined ||
      REASON_SEVERITY[candidate.reason] < REASON_SEVERITY[existing.reason]
    ) {
      rankedByTargets.set(key, candidate);
    }
  }

  const explicitOrders = new Set<string>();
  for (const relation of parsedGraph.relations) {
    const order = normalizedOrder(relation);
    if (order !== undefined) explicitOrders.add(`${order[0]}\u0000${order[1]}`);
  }

  for (const relation of parsedGraph.relations) {
    const order = normalizedOrder(relation);
    const reverseOrderExists =
      order !== undefined && explicitOrders.has(`${order[1]}\u0000${order[0]}`);
    if (reverseOrderExists || isZIndexConflict(relation, nodeById)) {
      addCandidate(
        "conflicting-relations",
        [relation.from, relation.to],
        relation.confidence,
      );
    }
    if (relation.kind === "occludes") {
      addCandidate("occlusion", [relation.from, relation.to], relation.confidence);
    }
  }

  for (const compound of parsedGraph.nodes.filter(
    ({ role }) => role === "compound-group",
  )) {
    const memberIds = parsedGraph.relations
      .filter(
        ({ kind, from, to }) =>
          (kind === "belongs-to" || kind === "connected-to") &&
          (from === compound.id || to === compound.id),
      )
      .flatMap(({ from, to }) => [from, to]);
    addCandidate("compound", [compound.id, ...memberIds]);
  }

  for (const relation of parsedGraph.relations) {
    if (relation.kind === "connected-to" || relation.kind === "belongs-to") {
      addCandidate("compound", [relation.from, relation.to], relation.confidence);
    }
  }

  for (const candidate of parsedGraph.nodes) {
    if (isProtectedNode(candidate)) continue;
    const { x, y, width, height } = candidate.bbox;
    if (
      x <= EDGE_EPSILON ||
      y <= EDGE_EPSILON ||
      x + width >= 1 - EDGE_EPSILON ||
      y + height >= 1 - EDGE_EPSILON
    ) {
      addCandidate("incomplete-boundary", [candidate.id]);
    }
  }

  return [...rankedByTargets.values()]
    .sort(
      (left, right) =>
        REASON_SEVERITY[left.reason] - REASON_SEVERITY[right.reason] ||
        left.confidence - right.confidence ||
        right.normalizedArea - left.normalizedArea ||
        compareTargetIdTuples(left.targetNodeIds, right.targetNodeIds),
    )
    .slice(0, limit)
    .map(({ confidence: _confidence, normalizedArea: _area, ...request }) => request);
}

export function mergeRefinedSubgraph(
  graph: SceneGraph,
  request: RefinementRequest,
  localGraph: SceneGraph,
): SceneGraph {
  SceneGraphSchema.parse(graph);
  SceneGraphSchema.parse(localGraph);
  const parsedGraph = graph;
  const parsedLocalGraph = localGraph;
  const crop = createBBoxSchema(parsedGraph.canvas).parse(request.crop);
  if (
    parsedLocalGraph.canvas.width !== crop.width ||
    parsedLocalGraph.canvas.height !== crop.height
  ) {
    throw new Error("Local scene graph canvas must equal the requested crop");
  }

  const targetNodeIds = new Set(request.targetNodeIds);
  if (targetNodeIds.size === 0 || targetNodeIds.size !== request.targetNodeIds.length) {
    throw new Error("Refinement targets must contain unique scene node IDs");
  }
  const originalNodeById = new Map(parsedGraph.nodes.map((candidate) => [candidate.id, candidate]));
  for (const targetNodeId of targetNodeIds) {
    const target = originalNodeById.get(targetNodeId);
    if (target === undefined) throw new Error(`Unknown refinement target: ${targetNodeId}`);
    if (isProtectedNode(target)) {
      throw new Error("Regional refinement cannot overwrite OCR or global nodes");
    }
  }

  const localNodes = parsedLocalGraph.nodes.filter(({ role }) => role !== "background");
  if (localNodes.length === 0) {
    throw new Error("Regional refinement must return at least one local node");
  }
  if (localNodes.length < targetNodeIds.size) {
    throw new Error(
      "Regional refinement must not replace more targets than it returns",
    );
  }
  const unrelatedNodeIds = new Set(
    parsedGraph.nodes
      .filter(({ id }) => !targetNodeIds.has(id))
      .map(({ id }) => id),
  );
  for (const localNode of localNodes) {
    if (localNode.role === "text") {
      throw new Error("Regional refinement cannot create or overwrite OCR nodes");
    }
    if (unrelatedNodeIds.has(localNode.id)) {
      throw new Error(`Regional refinement cannot overwrite unrelated node: ${localNode.id}`);
    }
  }

  const mappedNodes = localNodes.map((localNode): SceneNode => ({
    ...localNode,
    bbox: {
      x: (crop.x + localNode.bbox.x * crop.width) / parsedGraph.canvas.width,
      y: (crop.y + localNode.bbox.y * crop.height) / parsedGraph.canvas.height,
      width: (localNode.bbox.width * crop.width) / parsedGraph.canvas.width,
      height: (localNode.bbox.height * crop.height) / parsedGraph.canvas.height,
    },
  }));
  const { nodes: dedupedNodes } = deduplicateRefinedNodes(mappedNodes, targetNodeIds);
  const survivingOriginalNodes = parsedGraph.nodes.filter((originalNode) => {
    if (targetNodeIds.has(originalNode.id)) return false;
    if (isProtectedNode(originalNode)) return true;
    return !dedupedNodes.some(
      (refinedNode) =>
        intersectionOverUnion(originalNode.bbox, refinedNode.bbox) >
        DUPLICATE_IOU_THRESHOLD,
    );
  });
  const nodes = [
    ...survivingOriginalNodes,
    ...dedupedNodes,
  ];
  const mergedNodeIds = new Set(nodes.map(({ id }) => id));

  const keptRelations = parsedGraph.relations.filter(({ from, to }) => {
    const fromTarget = targetNodeIds.has(from);
    const toTarget = targetNodeIds.has(to);
    if (fromTarget && toTarget) return false;
    return mergedNodeIds.has(from) && mergedNodeIds.has(to);
  });
  const keptRelationIds = new Set(keptRelations.map(({ id }) => id));
  const localNodeIds = new Set(dedupedNodes.map(({ id }) => id));
  const localRelations = parsedLocalGraph.relations.filter(({ from, to }) => {
    return localNodeIds.has(from) && localNodeIds.has(to);
  });
  for (const localRelation of localRelations) {
    if (keptRelationIds.has(localRelation.id)) {
      throw new Error(`Regional refinement cannot overwrite unrelated relation: ${localRelation.id}`);
    }
  }

  const mergedGraph: SceneGraph = {
    graphVersion: 1,
    canvas: parsedGraph.canvas,
    nodes,
    relations: [...keptRelations, ...localRelations],
  };
  SceneGraphSchema.parse(mergedGraph);
  return mergedGraph;
}
