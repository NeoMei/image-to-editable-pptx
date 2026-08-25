import {
  SlideManifestSchema,
  type BBox,
  type OcrResult,
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

function clipAxis(
  start: number,
  length: number,
  limit: number,
): { start: number; length: number; clipped: boolean } {
  const end = start + length;
  let clippedStart = Math.max(0, Math.min(start, limit));
  let clippedEnd = Math.max(0, Math.min(end, limit));

  if (clippedEnd <= clippedStart) {
    clippedStart = Math.min(clippedStart, limit - 1);
    clippedEnd = clippedStart + 1;
  }

  return {
    start: clippedStart,
    length: clippedEnd - clippedStart,
    clipped: clippedStart !== start || clippedEnd !== end,
  };
}

function clipBBox(
  bbox: BBox,
  noteClipping: () => void,
): BBox {
  const horizontal = clipAxis(bbox.x, bbox.width, CANVAS_WIDTH);
  const vertical = clipAxis(bbox.y, bbox.height, CANVAS_HEIGHT);

  if (horizontal.clipped || vertical.clipped) {
    noteClipping();
  }

  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.length,
    height: vertical.length,
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
  const visionWithClippedBboxes = vision.elements.map((element) => ({
    element,
    bbox: clipBBox(element.bbox, noteClipping),
  }));
  const ocrWithClippedBboxes = ocr.lines.map((line) => ({
    line,
    bbox: clipBBox(line.bbox, noteClipping),
  }));
  const planned: PlannedElement[] = [];

  for (const [index, { line, bbox }] of ocrWithClippedBboxes.entries()) {
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
        id: `ocr-${index + 1}`,
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

  for (const [index, { element, bbox }] of visionWithClippedBboxes.entries()) {
    const id = `vision-${index + 1}`;

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
