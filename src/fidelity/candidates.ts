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
      ({ element }) =>
        element.editableAs === "bitmap" &&
        (element.type === "icon" || element.type === "illustration"),
    );

  const grouped = new Map<number, typeof bitmap>();
  const ungrouped: typeof bitmap = [];
  for (const candidate of bitmap) {
    const panel = panels.find(({ bbox }) =>
      centerInside(candidate.bbox, bbox),
    );
    if (panel === undefined) {
      ungrouped.push(candidate);
      continue;
    }
    const items = grouped.get(panel.sourceIndex) ?? [];
    items.push(candidate);
    grouped.set(panel.sourceIndex, items);
  }

  const icons: FidelityIconCandidate[] = [
    ...[...grouped.entries()].map(([panelIndex, items]) => ({
      kind: "icon" as const,
      id: `icon-panel-${panelIndex + 1}`,
      label: items.map(({ element }) => element.label).join(" + "),
      bbox: items.map(({ bbox }) => bbox).reduce(union),
      zIndex: Math.max(...items.map(({ element }) => element.zIndex)),
      sourceElementIndexes: items.map(({ sourceIndex }) => sourceIndex),
    })),
    ...ungrouped.map(({ element, bbox, sourceIndex }) => ({
      kind: "icon" as const,
      id: `icon-${sourceIndex + 1}`,
      label: element.label,
      bbox,
      zIndex: element.zIndex,
      sourceElementIndexes: [sourceIndex],
    })),
  ];

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
