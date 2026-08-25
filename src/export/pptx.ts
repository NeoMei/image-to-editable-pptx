import * as PptxGenJS from "pptxgenjs";

import type { BBox, SlideManifest } from "../contracts.js";

const SLIDE_WIDTH_INCHES = 13.333;
const SLIDE_HEIGHT_INCHES = 7.5;

// PptxGenJS 4.0.1's declaration file is interpreted as CommonJS by NodeNext,
// adding a type-only extra `default` layer that is absent from its ESM runtime.
type PptxGenConstructor = typeof PptxGenJS.default.default;
const PptxGenConstructor =
  PptxGenJS.default as unknown as PptxGenConstructor;

const pxToX = (px: number): number => (px * SLIDE_WIDTH_INCHES) / 1280;
const pxToY = (px: number): number => (px * SLIDE_HEIGHT_INCHES) / 720;
const pxToPt = (px: number): number => (px * 72) / 96;

function position(bbox: BBox): { x: number; y: number; w: number; h: number } {
  return {
    x: pxToX(bbox.x),
    y: pxToY(bbox.y),
    w: pxToX(bbox.width),
    h: pxToY(bbox.height),
  };
}

export async function exportPptx(
  manifest: SlideManifest,
  backgroundPath: string,
  outputPath: string,
): Promise<void> {
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
          ...position(element.bbox),
          objectName: `text-${element.id}`,
          fontFace: "Microsoft YaHei",
          fontSize: pxToPt(element.fontSizePx),
          color: element.color,
          align: element.align,
          rotate: element.rotation,
          fit: "none",
          margin: 0,
          isTextBox: true,
        });
        break;

      case "shape": {
        const options = {
          ...position(element.bbox),
          objectName: `shape-${element.id}`,
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
