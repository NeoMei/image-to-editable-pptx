import * as PptxGenJS from "pptxgenjs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { BBox, VersionedSlideManifest } from "../contracts.js";
import {
  layoutForCanvas,
  pixelsToPoints,
  pixelsToSlideWidth,
  positionForBBox,
  type SlideLayout,
} from "./layout.js";

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

const TRACKED_TEXT_BOX_SLACK_PX = 16;

function isWithinDirectory(directory: string, candidate: string): boolean {
  const child = relative(directory, candidate);
  return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

async function safeExportAssetPath(
  outputPath: string,
  assetPath: string,
): Promise<string> {
  const stagingDirectory = await realpath(dirname(resolve(outputPath)));
  const candidate = isAbsolute(assetPath)
    ? resolve(assetPath)
    : resolve(stagingDirectory, assetPath);
  const info = await lstat(candidate);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`PPTX asset must be a regular staged file: ${assetPath}`);
  }
  const canonicalCandidate = await realpath(candidate);
  if (!isWithinDirectory(stagingDirectory, canonicalCandidate)) {
    throw new Error(`Asset escapes PPTX output staging: ${assetPath}`);
  }
  return canonicalCandidate;
}

function textPosition(
  bbox: BBox,
  canvas: VersionedSlideManifest["canvas"],
  layout: SlideLayout,
  charSpacingPx?: number,
): { x: number; y: number; w: number; h: number } {
  if (charSpacingPx === undefined || charSpacingPx === 0) {
    return positionForBBox(bbox, canvas, layout);
  }
  return positionForBBox(
    {
      ...bbox,
      width: Math.min(
        canvas.width - bbox.x,
        bbox.width + TRACKED_TEXT_BOX_SLACK_PX,
      ),
    },
    canvas,
    layout,
  );
}

export async function exportPptx(
  manifest: VersionedSlideManifest,
  backgroundPath: string,
  outputPath: string,
): Promise<void> {
  for (const element of manifest.elements) {
    if (element.kind === "asset" && element.extraction !== "transparent") {
      throw new Error(`Refusing to export rectangular fidelity asset ${element.id}`);
    }
  }
  const stagedAssetPaths = new Map<string, string>();
  for (const element of manifest.elements) {
    if (element.kind === "asset") {
      stagedAssetPaths.set(
        element.id,
        await safeExportAssetPath(outputPath, element.assetPath),
      );
    }
  }

  const pptx = new PptxGenConstructor();
  const layout = layoutForCanvas(manifest.canvas);
  const layoutName = "SOURCE_CANVAS";
  pptx.defineLayout({
    name: layoutName,
    width: layout.widthInches,
    height: layout.heightInches,
  });
  pptx.layout = layoutName;

  const slide = pptx.addSlide();
  slide.addImage({
    path: backgroundPath,
    ...positionForBBox(
      {
        x: 0,
        y: 0,
        width: manifest.canvas.width,
        height: manifest.canvas.height,
      },
      manifest.canvas,
      layout,
    ),
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
            manifest.canvas,
            layout,
            element.charSpacingPx,
          ),
          objectName: `text-${element.id}`,
          fontFace: "Microsoft YaHei",
          fontSize: pixelsToPoints(element.fontSizePx, manifest.canvas, layout),
          ...(element.charSpacingPx === undefined
            ? {}
            : {
                charSpacing: pixelsToPoints(
                  element.charSpacingPx,
                  manifest.canvas,
                  layout,
                ),
              }),
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
          ...positionForBBox(element.bbox, manifest.canvas, layout),
          objectName: `shape-${element.id}-${element.label}`,
          fill: { color: element.fillColor },
          line: {
            color: element.strokeColor,
            width: pixelsToPoints(
              element.strokeWidthPx,
              manifest.canvas,
              layout,
            ),
          },
          ...(element.shape === "roundRect" && element.cornerRadiusPx > 0
            ? {
                rectRadius: pixelsToSlideWidth(
                  element.cornerRadiusPx,
                  manifest.canvas,
                  layout,
                ),
              }
            : {}),
        };
        slide.addShape(shapeTypes[element.shape], options);
        break;
      }

      case "asset":
        slide.addImage({
          path: stagedAssetPaths.get(element.id)!,
          ...positionForBBox(element.bbox, manifest.canvas, layout),
          objectName: `asset-${element.id}`,
        });
        break;
    }
  }

  await pptx.writeFile({ fileName: outputPath });
}
