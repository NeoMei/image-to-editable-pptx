import {
  OcrResultSchema,
  type BBox,
  type FidelityTextCandidate,
  type OcrResult,
} from "../contracts.js";
import {
  SceneGraphSchema,
  type CanvasSize,
  type SceneGraph,
  type SceneNode,
  type SceneRelation,
} from "./contracts.js";
import { createBBoxSchema, toPixelBBox } from "./geometry.js";

export type SemanticCandidateKind =
  | "foreground-object"
  | "text-backing"
  | "compound-group";

export type SemanticCandidate = {
  id: string;
  kind: SemanticCandidateKind;
  nodeIds: string[];
  bbox: BBox;
  zOrder: number;
  relations: string[];
  carriedTextIds: string[];
  occlusion?: { occluderIds: string[]; hiddenMaskRequired: true };
};

export type SemanticLayerPlan = {
  canvas: CanvasSize;
  text: FidelityTextCandidate[];
  candidates: SemanticCandidate[];
  backgroundNodeId: string;
  warnings: string[];
};

type CandidateDraft = Omit<SemanticCandidate, "zOrder" | "occlusion"> & {
  sourceZIndex: number;
};

const MIN_CANDIDATE_CONFIDENCE = 0.8;
const STRONG_DUPLICATE_IOU = 0.9;
const SUBSTANTIAL_OVERLAP_RATIO = 0.5;
const DEFAULT_TEXT_COLOR = "23394D";
const DEFAULT_TEXT_Z_INDEX = 100;

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

function compareCandidatePriority(left: CandidateDraft, right: CandidateDraft): number {
  return (
    left.sourceZIndex - right.sourceZIndex || compareCodePoints(left.id, right.id)
  );
}

function unionBBox(boxes: readonly BBox[]): BBox {
  const x = Math.min(...boxes.map((bbox) => bbox.x));
  const y = Math.min(...boxes.map((bbox) => bbox.y));
  const right = Math.max(...boxes.map((bbox) => bbox.x + bbox.width));
  const bottom = Math.max(...boxes.map((bbox) => bbox.y + bbox.height));
  return { x, y, width: right - x, height: bottom - y };
}

function intersectionArea(left: BBox, right: BBox): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}

function intersectionOverUnion(left: BBox, right: BBox): number {
  const intersection = intersectionArea(left, right);
  const total = left.width * left.height + right.width * right.height - intersection;
  return total === 0 ? 0 : intersection / total;
}

function intersectionOverSmallerArea(left: BBox, right: BBox): number {
  const smallerArea = Math.min(left.width * left.height, right.width * right.height);
  return smallerArea === 0 ? 0 : intersectionArea(left, right) / smallerArea;
}

function clipProviderBBox(
  bbox: OcrResult["lines"][number]["bbox"],
  canvas: CanvasSize,
): BBox | null {
  const x = Math.max(0, bbox.x);
  const y = Math.max(0, bbox.y);
  const right = Math.min(canvas.width, bbox.x + bbox.width);
  const bottom = Math.min(canvas.height, bbox.y + bbox.height);
  if (right <= x || bottom <= y) return null;
  return createBBoxSchema(canvas).parse({ x, y, width: right - x, height: bottom - y });
}

function planText(
  ocr: OcrResult,
  canvas: CanvasSize,
  warnings: Set<string>,
): FidelityTextCandidate[] {
  const candidates: FidelityTextCandidate[] = [];
  for (const [sourceIndex, line] of ocr.lines.entries()) {
    const bbox = clipProviderBBox(line.bbox, canvas);
    if (bbox === null) {
      warnings.add(`ocr_out_of_bounds:${sourceIndex + 1}`);
      continue;
    }
    if (
      bbox.x !== line.bbox.x ||
      bbox.y !== line.bbox.y ||
      bbox.width !== line.bbox.width ||
      bbox.height !== line.bbox.height
    ) {
      warnings.add("out_of_bounds_clipped");
    }
    const id = `ocr-${sourceIndex + 1}`;
    candidates.push({
      kind: "text",
      id,
      required: true,
      element: {
        kind: "text",
        id,
        text: line.text,
        bbox,
        rotation: 0,
        color: DEFAULT_TEXT_COLOR,
        fontSizePx: Math.max(1, Math.round(bbox.height * 0.72 * 100) / 100),
        align: "left",
        zIndex: DEFAULT_TEXT_Z_INDEX,
      },
    });
  }
  return candidates;
}

class DisjointSet {
  readonly parent = new Map<string, string>();

  constructor(ids: readonly string[]) {
    for (const id of ids) this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (parent === undefined) throw new Error(`Unknown scene node: ${id}`);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compareCodePoints);
    this.parent.set(second!, first!);
  }
}

function isProtectedRole(role: SceneNode["role"]): boolean {
  return role === "background" || role === "text";
}

function isStandaloneCandidateRole(role: SceneNode["role"]): boolean {
  return (
    role === "foreground-object" ||
    role === "text-backing" ||
    role === "compound-group"
  );
}

function orderEndpoints(
  relation: SceneRelation,
): { rear: string; front: string } | undefined {
  if (relation.kind === "in-front-of" || relation.kind === "occludes") {
    return { rear: relation.to, front: relation.from };
  }
  if (relation.kind === "behind") {
    return { rear: relation.from, front: relation.to };
  }
  return undefined;
}

function cycleComponents(
  candidateIds: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  function visit(id: string): void {
    indexes.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of [...(edges.get(id) ?? [])].sort(compareCodePoints)) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indexes.get(target)!));
      }
    }

    if (lowLinks.get(id) !== indexes.get(id)) return;
    const component: string[] = [];
    let popped: string;
    do {
      popped = stack.pop()!;
      onStack.delete(popped);
      component.push(popped);
    } while (popped !== id);
    component.sort(compareCodePoints);
    if (component.length > 1 || (edges.get(id)?.has(id) ?? false)) {
      cycles.push(component);
    }
  }

  for (const id of [...candidateIds].sort(compareCodePoints)) {
    if (!indexes.has(id)) visit(id);
  }
  return cycles.sort((left, right) => compareCodePoints(left.join("\0"), right.join("\0")));
}

function topologicalOrder(
  drafts: readonly CandidateDraft[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): CandidateDraft[] {
  const draftById = new Map(drafts.map((candidate) => [candidate.id, candidate]));
  const indegree = new Map(drafts.map((candidate) => [candidate.id, 0]));
  for (const [from, targets] of edges) {
    if (!indegree.has(from)) continue;
    for (const target of targets) {
      if (indegree.has(target)) indegree.set(target, indegree.get(target)! + 1);
    }
  }

  const ready = drafts.filter(({ id }) => indegree.get(id) === 0).sort(compareCandidatePriority);
  const ordered: CandidateDraft[] = [];
  while (ready.length > 0) {
    const candidate = ready.shift()!;
    ordered.push(candidate);
    for (const target of [...(edges.get(candidate.id) ?? [])].sort(compareCodePoints)) {
      if (!indegree.has(target)) continue;
      const remaining = indegree.get(target)! - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(draftById.get(target)!);
        ready.sort(compareCandidatePriority);
      }
    }
  }
  return ordered;
}

export function planSemanticLayers(
  graph: SceneGraph,
  ocr: OcrResult,
): SemanticLayerPlan {
  SceneGraphSchema.parse(graph);
  OcrResultSchema.parse(ocr);
  const parsedGraph = graph;
  const parsedOcr = ocr;
  const warnings = new Set<string>();
  const textPlan = planText(parsedOcr, parsedGraph.canvas, warnings);
  const nodeById = new Map(parsedGraph.nodes.map((candidate) => [candidate.id, candidate]));
  const pixelBoxById = new Map(
    parsedGraph.nodes.map((candidate) => [
      candidate.id,
      toPixelBBox(candidate.bbox, parsedGraph.canvas),
    ]),
  );
  const groups = new DisjointSet(parsedGraph.nodes.map(({ id }) => id));

  const duplicateEligible = parsedGraph.nodes.filter(
    ({ role }) => !isProtectedRole(role) && role !== "decoration",
  );
  for (let leftIndex = 0; leftIndex < duplicateEligible.length; leftIndex += 1) {
    const left = duplicateEligible[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < duplicateEligible.length; rightIndex += 1) {
      const right = duplicateEligible[rightIndex]!;
      if (
        left.role === right.role &&
        intersectionOverUnion(pixelBoxById.get(left.id)!, pixelBoxById.get(right.id)!) >=
          STRONG_DUPLICATE_IOU
      ) {
        groups.union(left.id, right.id);
      }
    }
  }

  const compositionRelations = parsedGraph.relations.filter(
    ({ kind }) => kind === "belongs-to" || kind === "connected-to",
  );
  for (const relation of compositionRelations) {
    const from = nodeById.get(relation.from)!;
    const to = nodeById.get(relation.to)!;
    if (!isProtectedRole(from.role) && !isProtectedRole(to.role)) {
      groups.union(from.id, to.id);
    }
  }

  const groupedNodes = new Map<string, SceneNode[]>();
  for (const candidate of parsedGraph.nodes) {
    const root = groups.find(candidate.id);
    const members = groupedNodes.get(root) ?? [];
    members.push(candidate);
    groupedNodes.set(root, members);
  }

  const drafts: CandidateDraft[] = [];
  const candidateIdByNodeId = new Map<string, string>();
  for (const membersUnsorted of groupedNodes.values()) {
    const members = [...membersUnsorted].sort((left, right) =>
      compareCodePoints(left.id, right.id),
    );
    const candidateMembers = members.filter(
      ({ role }) => !isProtectedRole(role) && role !== "decoration",
    );
    const hasStandaloneRole = candidateMembers.some(({ role }) =>
      isStandaloneCandidateRole(role),
    );
    const hasInternalComposition = compositionRelations.some(
      ({ from, to }) =>
        groups.find(from) === groups.find(to) &&
        groups.find(from) === groups.find(members[0]!.id),
    );
    if (!hasStandaloneRole && !hasInternalComposition) continue;

    let kind: SemanticCandidateKind;
    if (
      hasInternalComposition ||
      candidateMembers.some(({ role }) => role === "compound-group")
    ) {
      kind = "compound-group";
    } else {
      const role = candidateMembers[0]!.role;
      kind = role === "text-backing" ? "text-backing" : "foreground-object";
    }
    const nodeIds = members.map(({ id }) => id);
    const compoundNodeIds = members
      .filter(({ role }) => role === "compound-group")
      .map(({ id: nodeId }) => nodeId);
    const nestedCompoundIds = new Set(
      compositionRelations
        .filter(
          ({ kind: relationKind, from, to }) =>
            relationKind === "belongs-to" &&
            compoundNodeIds.includes(from) &&
            compoundNodeIds.includes(to),
        )
        .map(({ from }) => from),
    );
    const outerCompoundId = compoundNodeIds.find(
      (nodeId) => !nestedCompoundIds.has(nodeId),
    );
    const id =
      kind === "compound-group" && compoundNodeIds.length > 0
        ? (outerCompoundId ?? compoundNodeIds[0]!)
        : nodeIds[0]!;
    for (const nodeId of nodeIds) candidateIdByNodeId.set(nodeId, id);
    drafts.push({
      id,
      kind,
      nodeIds,
      bbox: unionBBox(members.map(({ id: nodeId }) => pixelBoxById.get(nodeId)!)),
      sourceZIndex: Math.min(...members.map(({ zIndex }) => zIndex ?? 0)),
      relations: parsedGraph.relations
        .filter(({ from, to }) => nodeIds.includes(from) || nodeIds.includes(to))
        .map(({ id: relationId }) => relationId)
        .sort(compareCodePoints),
      carriedTextIds: [],
    });
  }

  const rejected = new Set<string>();
  for (const candidate of parsedGraph.nodes) {
    if (candidate.role === "decoration") {
      warnings.add(`decoration_candidate:${candidate.id}`);
      const candidateId = candidateIdByNodeId.get(candidate.id);
      if (candidateId !== undefined) rejected.add(candidateId);
    }
    if (
      !isProtectedRole(candidate.role) &&
      candidate.role !== "decoration" &&
      candidate.confidence < MIN_CANDIDATE_CONFIDENCE
    ) {
      warnings.add(`uncertain_candidate:${candidate.id}`);
      const candidateId = candidateIdByNodeId.get(candidate.id);
      if (candidateId !== undefined) rejected.add(candidateId);
    }
  }

  for (const relation of parsedGraph.relations) {
    if (relation.kind !== "carries-text") continue;
    const targetBox = pixelBoxById.get(relation.to)!;
    const carriedTextIds = textPlan
      .filter(
        ({ element }) =>
          intersectionOverSmallerArea(targetBox, element.bbox) >=
          SUBSTANTIAL_OVERLAP_RATIO,
      )
      .map(({ id }) => id)
      .sort(compareCodePoints);
    const hasOcrAssociation = carriedTextIds.length > 0;
    const candidateId = candidateIdByNodeId.get(relation.from);
    if (hasOcrAssociation && candidateId !== undefined) {
      const draft = drafts.find(({ id }) => id === candidateId)!;
      draft.carriedTextIds = [...new Set([
        ...draft.carriedTextIds,
        ...carriedTextIds,
      ])].sort(compareCodePoints);
    }
    if (!hasOcrAssociation) {
      warnings.add(`dangling_ocr_association:${relation.from},${relation.to}`);
      if (candidateId !== undefined) rejected.add(candidateId);
    }
  }

  for (let leftIndex = 0; leftIndex < drafts.length; leftIndex += 1) {
    const left = drafts[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < drafts.length; rightIndex += 1) {
      const right = drafts[rightIndex]!;
      const leftBackings = left.nodeIds.filter(
        (nodeId) => nodeById.get(nodeId)!.role === "text-backing",
      );
      const leftObjects = left.nodeIds.filter(
        (nodeId) => nodeById.get(nodeId)!.role === "foreground-object",
      );
      const rightBackings = right.nodeIds.filter(
        (nodeId) => nodeById.get(nodeId)!.role === "text-backing",
      );
      const rightObjects = right.nodeIds.filter(
        (nodeId) => nodeById.get(nodeId)!.role === "foreground-object",
      );
      const hasSubstantialMemberOverlap = [
        ...leftBackings.flatMap((backingId) =>
          rightObjects.map((objectId) => [backingId, objectId] as const),
        ),
        ...rightBackings.flatMap((backingId) =>
          leftObjects.map((objectId) => [backingId, objectId] as const),
        ),
      ].some(
        ([backingId, objectId]) =>
          intersectionOverSmallerArea(
            pixelBoxById.get(backingId)!,
            pixelBoxById.get(objectId)!,
          ) >= SUBSTANTIAL_OVERLAP_RATIO,
      );
      if (hasSubstantialMemberOverlap) {
        const ids = [left.id, right.id].sort(compareCodePoints);
        warnings.add(`ambiguous_substantial_overlap:${ids.join(",")}`);
        rejected.add(left.id);
        rejected.add(right.id);
      }
    }
  }

  const nodeEdges = new Map<string, Set<string>>(
    parsedGraph.nodes.map(({ id }) => [id, new Set<string>()]),
  );
  for (const relation of parsedGraph.relations) {
    const order = orderEndpoints(relation);
    if (order !== undefined) nodeEdges.get(order.rear)!.add(order.front);
  }
  for (const cycle of cycleComponents(
    parsedGraph.nodes.map(({ id }) => id),
    nodeEdges,
  )) {
    warnings.add(`cycle_in_layer_order:${cycle.join(",")}`);
    for (const nodeId of cycle) {
      const candidateId = candidateIdByNodeId.get(nodeId);
      if (candidateId !== undefined) rejected.add(candidateId);
    }
  }

  const edges = new Map<string, Set<string>>();
  for (const draft of drafts) edges.set(draft.id, new Set());
  for (const draft of drafts) {
    const visited = new Set(draft.nodeIds);
    const pending = [...draft.nodeIds].sort(compareCodePoints);
    while (pending.length > 0) {
      const nodeId = pending.shift()!;
      for (const targetNodeId of [...(nodeEdges.get(nodeId) ?? [])].sort(
        compareCodePoints,
      )) {
        const targetCandidateId = candidateIdByNodeId.get(targetNodeId);
        if (
          targetCandidateId !== undefined &&
          targetCandidateId !== draft.id
        ) {
          edges.get(draft.id)!.add(targetCandidateId);
        }
        if (!visited.has(targetNodeId)) {
          visited.add(targetNodeId);
          pending.push(targetNodeId);
          pending.sort(compareCodePoints);
        }
      }
    }
  }

  for (const cycle of cycleComponents(drafts.map(({ id }) => id), edges)) {
    warnings.add(`cycle_in_layer_order:${cycle.join(",")}`);
    for (const candidateId of cycle) rejected.add(candidateId);
  }

  const acceptedDrafts = drafts.filter(({ id }) => !rejected.has(id));
  const acceptedIds = new Set(acceptedDrafts.map(({ id }) => id));
  const acceptedEdges = new Map<string, Set<string>>();
  for (const candidate of acceptedDrafts) {
    acceptedEdges.set(
      candidate.id,
      new Set(
        [...(edges.get(candidate.id) ?? [])].filter((target) => acceptedIds.has(target)),
      ),
    );
  }

  const ordered = topologicalOrder(acceptedDrafts, acceptedEdges);
  const candidates: SemanticCandidate[] = ordered.map(
    ({ sourceZIndex: _sourceZIndex, ...candidate }, zOrder) => {
      const occluderIds = parsedGraph.relations
        .filter(({ kind, to }) =>
          kind === "occludes" && candidate.nodeIds.includes(to),
        )
        .map(({ from }) => ({
          nodeId: from,
          candidateId: candidateIdByNodeId.get(from),
        }))
        .filter(
          (
            association,
          ): association is { nodeId: string; candidateId: string } =>
            association.candidateId !== undefined &&
            association.candidateId !== candidate.id &&
            acceptedIds.has(association.candidateId),
        )
        .map(({ nodeId }) => nodeId)
        .filter((nodeId, index, all) => all.indexOf(nodeId) === index)
        .sort(compareCodePoints);
      return {
        ...candidate,
        zOrder,
        ...(occluderIds.length > 0
          ? {
              occlusion: {
                occluderIds,
                hiddenMaskRequired: true as const,
              },
            }
          : {}),
      };
    },
  );

  return {
    canvas: parsedGraph.canvas,
    text: textPlan,
    candidates,
    backgroundNodeId: parsedGraph.nodes.find(({ role }) => role === "background")!.id,
    warnings: [...warnings].sort(compareCodePoints),
  };
}
