import {
  CanvasSizeSchema,
  type CanvasSize,
} from "../scene/contracts.js";

export function createScenePrompt(canvas: CanvasSize): string {
  const owningCanvas = CanvasSizeSchema.parse(canvas);
  return `Analyze the complete slide and return JSON only, with no prose or Markdown.
The source canvas is ${owningCanvas.width} x ${owningCanvas.height} pixels. Use it only as spatial context; do not return pixel coordinates.
Return exactly {"nodes":[...],"relations":[...]} with no additional fields.
For every node return id, role, bbox, confidence, label, extractionHints, and optional zIndex.
role must be one of: background | text | text-backing | foreground-object | connector | compound-group | decoration.
bbox must be [x1,y1,x2,y2] in normalized thousandths from 0 through 1000, where 0 is the top or left edge and 1000 is the bottom or right edge. Coordinates must be integers and x2/y2 must exceed x1/y1.
Return exactly one background node covering the complete canvas.
Identify every independently movable foreground object as its own node, even when nearby objects share a panel or visual theme.
Use compound-group only when visible connectivity or a shared contour means the parts must move together. Represent visible lines or arrows as connector nodes and describe connectivity with relations.
Use text-backing for a visible surface that carries text and link it to the text node with carries-text. OCR is authoritative for text content and geometry; Vision text labels must not replace or duplicate OCR output.
Describe partial occlusion with occludes and explicit layer order with in-front-of or behind. Do not infer hidden content that is not visible.
relation kind must be one of: belongs-to | connected-to | carries-text | occludes | in-front-of | behind.
For every relation return id, kind, from, to, and confidence, and reference only node IDs present in this response.
Labels are audit-only descriptions for human review. They must not imply extraction or planning decisions; encode decisions only with roles, relations, geometry, confidence, zIndex, and extractionHints.`;
}
