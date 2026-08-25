import {
  SlideManifestSchema,
  type BBox,
  type OcrResult,
  type ProviderBBox,
  type SlideElement,
  type SlideManifest,
  type VisionResult,
} from "./contracts.js";

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const DEFAULT_TEXT_COLOR = "23394D";
const DEFAULT_TEXT_Z_INDEX = 100;
const NATIVE_SHAPE_CONFIDENCE = 0.85;

type PlannedElement = {
  element: SlideElement;
  inputOrder: number;
};

function clipBBox(
  bbox: ProviderBBox,
  noteClipping: () => void,
): BBox | null {
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
}

function intersectionOverUnion(left: BBox, right: BBox): number {
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
}

function estimateFontSize(height: number): number {
  const estimate = Math.min(88, Math.max(14, height * 0.72));
  return Math.round(estimate * 100) / 100;
}

function isRectangle(
  element: VisionResult["elements"][number],
): boolean {
  return element.type === "panel" || element.type === "shape";
}

export function planSlide(
  ocr: OcrResult,
  vision: VisionResult,
): SlideManifest {
  let wasClipped = false;
  let inputOrder = 0;
  const noteClipping = (): void => {
    wasClipped = true;
  };
  const visionWithClippedBboxes = vision.elements.flatMap(
    (element, sourceIndex) => {
      const bbox = clipBBox(element.bbox, noteClipping);
      return bbox === null ? [] : [{ element, bbox, sourceIndex }];
    },
  );
  const ocrWithClippedBboxes = ocr.lines.flatMap((line, sourceIndex) => {
    const bbox = clipBBox(line.bbox, noteClipping);
    return bbox === null ? [] : [{ line, bbox, sourceIndex }];
  });
  const planned: PlannedElement[] = [];

  for (const { line, bbox, sourceIndex } of ocrWithClippedBboxes) {
    const visualTextHint = visionWithClippedBboxes
      .filter(({ element }) => element.type === "text")
      .map((candidate) => ({
        candidate,
        overlap: intersectionOverUnion(bbox, candidate.bbox),
      }))
      .filter(({ overlap }) => overlap > 0.5)
      .sort((left, right) => right.overlap - left.overlap)[0]?.candidate.element;

    planned.push({
      element: {
        kind: "text",
        id: `ocr-${sourceIndex + 1}`,
        text: line.text,
        bbox,
        rotation: 0,
        color: visualTextHint?.fillColor ?? DEFAULT_TEXT_COLOR,
        fontSizePx: estimateFontSize(bbox.height),
        align: "left",
        zIndex: DEFAULT_TEXT_Z_INDEX,
      },
      inputOrder: inputOrder++,
    });
  }

  for (const { element, bbox, sourceIndex } of visionWithClippedBboxes) {
    const id = `vision-${sourceIndex + 1}`;

    if (element.type === "text") {
      const overlapsOcr = ocrWithClippedBboxes.some(
        ({ bbox: ocrBBox }) => intersectionOverUnion(bbox, ocrBBox) > 0.5,
      );
      if (!overlapsOcr) {
        planned.push({
          element: {
            kind: "text",
            id,
            text: element.label,
            bbox,
            rotation: 0,
            color: element.fillColor ?? DEFAULT_TEXT_COLOR,
            fontSizePx: estimateFontSize(bbox.height),
            align: "left",
            zIndex: element.zIndex,
          },
          inputOrder: inputOrder++,
        });
      }
      continue;
    }

    if (isRectangle(element) && element.confidence >= NATIVE_SHAPE_CONFIDENCE) {
      const cornerRadiusPx = element.cornerRadius ?? 0;
      planned.push({
        element: {
          kind: "shape",
          id,
          shape: cornerRadiusPx > 0 ? "roundRect" : "rect",
          bbox,
          fillColor: element.fillColor ?? "FFFFFF",
          strokeColor: element.strokeColor ?? DEFAULT_TEXT_COLOR,
          strokeWidthPx: 1,
          cornerRadiusPx,
          zIndex: element.zIndex,
        },
        inputOrder: inputOrder++,
      });
      continue;
    }

    planned.push({
      element: {
        kind: "asset",
        id,
        label: element.label,
        bbox,
        extraction: isRectangle(element) ? "rectangular" : "transparent",
        assetPath: `assets/${id}.png`,
        zIndex: element.zIndex,
      },
      inputOrder: inputOrder++,
    });
  }

  planned.sort(
    (left, right) =>
      left.element.zIndex - right.element.zIndex ||
      left.inputOrder - right.inputOrder,
  );

  return SlideManifestSchema.parse({
    manifestVersion: 1,
    canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    elements: planned.map(({ element }) => element),
    warnings: wasClipped ? ["out_of_bounds_clipped"] : [],
  });
}
