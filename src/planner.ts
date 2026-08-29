import {
  SlideManifestV1Schema,
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

type OcrCandidate = {
  text: string;
  bbox: BBox;
  sourceIndex: number;
  lastLineBBox: BBox;
  lineFontSizes: number[];
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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  return Math.round(value * 100) / 100;
}

function unionBBox(left: BBox, right: BBox): BBox {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottom = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottom - y };
}

function areAdjacentBodyLines(left: BBox, right: BBox): boolean {
  const verticalGap = right.y - (left.y + left.height);
  const smallerHeight = Math.min(left.height, right.height);
  const leftFontSize = estimateFontSize(left.height);
  const rightFontSize = estimateFontSize(right.height);
  const fontSizeRatio =
    Math.max(leftFontSize, rightFontSize) /
    Math.min(leftFontSize, rightFontSize);
  const alignmentTolerance = Math.max(
    4,
    Math.min(leftFontSize, rightFontSize) * 0.5,
  );

  return (
    verticalGap >= 0 &&
    verticalGap <= Math.max(4, smallerHeight * 0.75) &&
    Math.abs(left.x - right.x) <= alignmentTolerance &&
    fontSizeRatio <= 1.2
  );
}

function mergeAdjacentOcrLines(
  lines: ReadonlyArray<{
    line: OcrResult["lines"][number];
    bbox: BBox;
    sourceIndex: number;
  }>,
): OcrCandidate[] {
  const merged: OcrCandidate[] = [];

  for (const { line, bbox, sourceIndex } of lines) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      areAdjacentBodyLines(previous.lastLineBBox, bbox)
    ) {
      previous.text = `${previous.text}\n${line.text}`;
      previous.bbox = unionBBox(previous.bbox, bbox);
      previous.lastLineBBox = bbox;
      previous.lineFontSizes.push(estimateFontSize(bbox.height));
      continue;
    }

    merged.push({
      text: line.text,
      bbox,
      sourceIndex,
      lastLineBBox: bbox,
      lineFontSizes: [estimateFontSize(bbox.height)],
    });
  }

  return merged;
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
      if (
        element.type === "background" ||
        element.editableAs === "background"
      ) {
        return [];
      }
      const bbox = clipBBox(element.bbox, noteClipping);
      return bbox === null ? [] : [{ element, bbox, sourceIndex }];
    },
  );
  const ocrWithClippedBboxes = ocr.lines.flatMap((line, sourceIndex) => {
    const bbox = clipBBox(line.bbox, noteClipping);
    return bbox === null ? [] : [{ line, bbox, sourceIndex }];
  });
  const mergedOcrCandidates = mergeAdjacentOcrLines(ocrWithClippedBboxes);
  const planned: PlannedElement[] = [];

  for (const { text, bbox, sourceIndex, lineFontSizes } of mergedOcrCandidates) {
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
        text,
        bbox,
        rotation: 0,
        color: visualTextHint?.fillColor ?? DEFAULT_TEXT_COLOR,
        fontSizePx: median(lineFontSizes),
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
          label: element.label,
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

  return SlideManifestV1Schema.parse({
    manifestVersion: 1,
    canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    elements: planned.map(({ element }) => element),
    warnings: wasClipped ? ["out_of_bounds_clipped"] : [],
  });
}
