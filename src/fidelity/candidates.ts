import type {
  BBox,
  FidelityIconCandidate,
  FidelityPlan,
  OcrResult,
  ProviderBBox,
  VisionResult,
} from "../contracts.js";
import { planSlide } from "../planner.js";

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const MIN_MAJOR_CANDIDATE_CONFIDENCE = 0.8;
const MIN_MAJOR_CANDIDATE_DIMENSION_PX = 24;
const MIN_MAJOR_CANDIDATE_AREA_PX2 = 1600;
const MIN_STRONG_INTERSECTION_OVER_UNION = 0.25;

const clipBBox = (
  bbox: ProviderBBox,
  noteClipping: () => void,
): BBox | null => {
  const right = bbox.x + bbox.width;
  const bottom = bbox.y + bbox.height;
  const clippedLeft = Math.max(0, bbox.x);
  const clippedTop = Math.max(0, bbox.y);
  const clippedRight = Math.min(CANVAS_WIDTH, right);
  const clippedBottom = Math.min(CANVAS_HEIGHT, bottom);

  if (
    clippedLeft !== bbox.x ||
    clippedTop !== bbox.y ||
    clippedRight !== right ||
    clippedBottom !== bottom
  ) {
    noteClipping();
  }

  if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) {
    return null;
  }

  return {
    x: clippedLeft,
    y: clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
  };
};

const union = (left: BBox, right: BBox): BBox => {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottom = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottom - y };
};

const centerInside = (inner: BBox, outer: BBox): boolean => {
  const x = inner.x + inner.width / 2;
  const y = inner.y + inner.height / 2;
  return (
    x >= outer.x &&
    x <= outer.x + outer.width &&
    y >= outer.y &&
    y <= outer.y + outer.height
  );
};

const intersectionOverUnion = (left: BBox, right: BBox): number => {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) -
      Math.max(left.x, right.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) -
      Math.max(left.y, right.y),
  );
  const intersectionArea = intersectionWidth * intersectionHeight;
  const unionArea =
    left.width * left.height + right.width * right.height - intersectionArea;
  return unionArea === 0 ? 0 : intersectionArea / unionArea;
};

export function planFidelityCandidates(
  ocr: OcrResult,
  vision: VisionResult,
): FidelityPlan {
  const textPlan = planSlide(ocr, { elements: [] });
  const text = textPlan.elements
    .filter((element) => element.kind === "text")
    .map((element) => ({
      kind: "text" as const,
      id: element.id,
      required: true as const,
      element,
    }));

  let wasClipped = false;
  const visionWithClippedBboxes = vision.elements.flatMap(
    (element, sourceIndex) => {
      if (
        element.type === "background" ||
        element.editableAs === "background"
      ) {
        return [];
      }
      const bbox = clipBBox(element.bbox, () => {
        wasClipped = true;
      });
      return bbox === null ? [] : [{ element, bbox, sourceIndex }];
    },
  );
  const panels = visionWithClippedBboxes
    .filter(({ element }) => element.type === "panel");
  const bitmap = visionWithClippedBboxes
    .filter(
      ({ element, bbox }) =>
        element.editableAs === "bitmap" &&
        (element.type === "icon" || element.type === "illustration") &&
        element.confidence >= MIN_MAJOR_CANDIDATE_CONFIDENCE &&
        bbox.width >= MIN_MAJOR_CANDIDATE_DIMENSION_PX &&
        bbox.height >= MIN_MAJOR_CANDIDATE_DIMENSION_PX &&
        bbox.width * bbox.height >= MIN_MAJOR_CANDIDATE_AREA_PX2,
    );

  const groups: Array<{
    panelIndex: number | undefined;
    items: typeof bitmap;
  }> = [];
  for (const candidate of bitmap) {
    const panel = panels.find(({ bbox }) =>
      centerInside(candidate.bbox, bbox),
    );
    const panelIndex = panel?.sourceIndex;
    const matchingGroupIndexes = groups.flatMap(
      ({ panelIndex: existingPanelIndex, items }, groupIndex) =>
        existingPanelIndex === panelIndex &&
        items.some(
          (item) =>
            intersectionOverUnion(item.bbox, candidate.bbox) >=
            MIN_STRONG_INTERSECTION_OVER_UNION,
        )
          ? [groupIndex]
          : [],
    );
    if (matchingGroupIndexes.length === 0) {
      groups.push({ panelIndex, items: [candidate] });
    } else {
      const target = groups[matchingGroupIndexes[0]!]!;
      target.items.push(candidate);
      for (const groupIndex of matchingGroupIndexes.slice(1).reverse()) {
        target.items.push(...groups[groupIndex]!.items);
        groups.splice(groupIndex, 1);
      }
    }
  }

  const icons: FidelityIconCandidate[] = groups.map(({ panelIndex, items }) => {
    const orderedItems = [...items].sort(
      (left, right) => left.sourceIndex - right.sourceIndex,
    );
    if (orderedItems.length === 1) {
      const { element, bbox, sourceIndex } = orderedItems[0]!;
      return {
        kind: "icon" as const,
        id: `icon-${sourceIndex + 1}`,
        label: element.label,
        bbox,
        zIndex: element.zIndex,
        sourceElementIndexes: [sourceIndex],
      };
    }
    return {
      kind: "icon" as const,
      id:
        panelIndex === undefined
          ? `icon-group-${orderedItems[0]!.sourceIndex + 1}`
          : `icon-panel-${panelIndex + 1}`,
      label: orderedItems.map(({ element }) => element.label).join(" + "),
      bbox: orderedItems.map(({ bbox }) => bbox).reduce(union),
      zIndex: Math.max(...orderedItems.map(({ element }) => element.zIndex)),
      sourceElementIndexes: orderedItems.map(({ sourceIndex }) => sourceIndex),
    };
  });

  return {
    canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    text,
    icons,
    warnings:
      wasClipped || textPlan.warnings.includes("out_of_bounds_clipped")
        ? ["out_of_bounds_clipped"]
        : [],
  };
}
