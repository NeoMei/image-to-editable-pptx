import * as PptxGenJS from "pptxgenjs";

import type { BBox, SlideManifest } from "../contracts.js";

const SLIDE_WIDTH_INCHES = 13.333;
const SLIDE_HEIGHT_INCHES = 7.5;

// tsx on Node 22.6 exposes PptxGenJS as `{ default: constructor }`, while
// newer Node runtimes expose the constructor directly. Normalize both shapes.
type PptxGenConstructor = typeof PptxGenJS.default.default;
const runtimeDefault: unknown = PptxGenJS.default;
const runtimeConstructor =
  typeof runtimeDefault === "function"
    ? runtimeDefault
    : typeof runtimeDefault === "object" &&
        runtimeDefault !== null &&
        "default" in runtimeDefault
      ? runtimeDefault.default
      : undefined;
if (typeof runtimeConstructor !== "function") {
  throw new TypeError("PptxGenJS did not expose a constructor");
}
const PptxGenConstructor = runtimeConstructor as PptxGenConstructor;

const pxToX = (px: number): number => (px * SLIDE_WIDTH_INCHES) / 1280;
const pxToY = (px: number): number => (px * SLIDE_HEIGHT_INCHES) / 720;
const pxToPt = (px: number): number => (px * 72) / 96;
const TRACKED_TEXT_BOX_SLACK_PX = 16;

function position(bbox: BBox): { x: number; y: number; w: number; h: number } {
  return {
    x: pxToX(bbox.x),
    y: pxToY(bbox.y),
    w: pxToX(bbox.width),
    h: pxToY(bbox.height),
  };
}

function textPosition(
  bbox: BBox,
  canvasWidth: number,
  charSpacingPx?: number,
): { x: number; y: number; w: number; h: number } {
  if (charSpacingPx === undefined || charSpacingPx === 0) {
    return position(bbox);
  }
  return position({
    ...bbox,
    width: Math.min(
      canvasWidth - bbox.x,
      bbox.width + TRACKED_TEXT_BOX_SLACK_PX,
    ),
  });
}

export async function exportPptx(
  manifest: SlideManifest,
  backgroundPath: string,
  outputPath: string,
): Promise<void> {
  for (const element of manifest.elements) {
    if (element.kind === "asset" && element.extraction !== "transparent") {
      throw new Error(`Refusing to export rectangular fidelity asset ${element.id}`);
    }
  }

  const pptx = new PptxGenConstructor();
  pptx.layout = "LAYOUT_WIDE";

  const slide = pptx.addSlide();
  slide.addImage({
    path: backgroundPath,
    x: 0,
    y: 0,
    w: pxToX(manifest.canvas.width),
    h: pxToY(manifest.canvas.height),
    objectName: "asset-background",
  });

  const shapeTypes = {
    rect: pptx.ShapeType.rect,
    roundRect: pptx.ShapeType.roundRect,
    ellipse: pptx.ShapeType.ellipse,
    line: pptx.ShapeType.line,
  } as const;

  for (const element of manifest.elements) {
    switch (element.kind) {
      case "text":
        slide.addText(element.text, {
          ...textPosition(
            element.bbox,
            manifest.canvas.width,
            element.charSpacingPx,
          ),
          objectName: `text-${element.id}`,
          fontFace: "Microsoft YaHei",
          fontSize: pxToPt(element.fontSizePx),
          ...(element.charSpacingPx === undefined
            ? {}
            : { charSpacing: pxToPt(element.charSpacingPx) }),
          ...(element.bold === undefined ? {} : { bold: element.bold }),
          color: element.color,
          align: element.align,
          valign: "middle",
          rotate: element.rotation,
          fit: "none",
          margin: 0,
          isTextBox: true,
        });
        break;

      case "shape": {
        const options = {
          ...position(element.bbox),
          objectName: `shape-${element.id}-${element.label}`,
          fill: { color: element.fillColor },
          line: {
            color: element.strokeColor,
            width: pxToPt(element.strokeWidthPx),
          },
          ...(element.shape === "roundRect" && element.cornerRadiusPx > 0
            ? { rectRadius: pxToX(element.cornerRadiusPx) }
            : {}),
        };
        slide.addShape(shapeTypes[element.shape], options);
        break;
      }

      case "asset":
        slide.addImage({
          path: element.assetPath,
          ...position(element.bbox),
          objectName: `asset-${element.id}`,
        });
        break;
    }
  }

  await pptx.writeFile({ fileName: outputPath });
}
