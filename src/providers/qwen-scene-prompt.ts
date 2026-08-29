import {
  CanvasSizeSchema,
  type CanvasSize,
} from "../scene/contracts.js";
import type { RefinementRequest } from "../scene/refine.js";

export function createScenePrompt(canvas: CanvasSize): string {
  const owningCanvas = CanvasSizeSchema.parse(canvas);
  return `Analyze the complete slide and return JSON only, with no prose or Markdown.
The source canvas is ${owningCanvas.width} x ${owningCanvas.height} pixels. Use it only as spatial context; do not return pixel coordinates.
Return exactly {"nodes":[...],"relations":[...]} with no additional fields.
For every node return id, role, bbox, confidence, label, extractionHints, and optional zIndex.
extractionHints must be an array of strings; return [] when there are none.
confidence must be between 0 and 1.
role must be one of: background | text | text-backing | foreground-object | connector | compound-group | decoration.
bbox must be [x1,y1,x2,y2] in normalized thousandths from 0 through 1000, where 0 is the top or left edge and 1000 is the bottom or right edge. Coordinates must be integers and x2/y2 must exceed x1/y1.
Return exactly one background node covering the complete canvas.
Identify every independently movable foreground object as its own node, even when nearby objects share a panel or visual theme.
Use compound-group only when visible connectivity or a shared contour means the parts must move together. Represent visible lines or arrows as connector nodes and describe connectivity with relations.
Use text-backing for a visible surface that carries text and link it to the text node with carries-text. OCR is authoritative for text content and geometry; Vision text labels must not replace or duplicate OCR output.
Describe partial occlusion with occludes and explicit layer order with in-front-of or behind. Do not infer hidden content that is not visible.
relation kind must be one of: belongs-to | connected-to | carries-text | occludes | in-front-of | behind.
Use carries-text only from a text-backing surface to the text it carries; when text sits inside a foreground object, link the text node to the object with belongs-to instead.
For every relation return id, kind, from, to, and confidence, and reference only node IDs present in this response.
Labels are audit-only descriptions for human review. They must not imply extraction or planning decisions; encode decisions only with roles, relations, geometry, confidence, zIndex, and extractionHints.`;
}

export function createRegionalScenePrompt(
  canvas: CanvasSize,
  request: RefinementRequest,
): string {
  const owningCanvas = CanvasSizeSchema.parse(canvas);
  return `Analyze only the supplied regional crop and return JSON only, with no prose or Markdown.
The supplied image is exactly ${owningCanvas.width} x ${owningCanvas.height} pixels and contains no pixels outside the requested crop.
Refine only these target node IDs: ${JSON.stringify(request.targetNodeIds)}.
The generic ambiguity reason is ${JSON.stringify(request.reason)}.
Return exactly {"nodes":[...],"relations":[...]} with no additional fields.
Use normalized thousandths from 0 through 1000 relative to this crop, never the complete slide.
Return exactly one background node covering the complete crop. It is coordinate context only and will not replace the slide background.
Return only replacement nodes and relations for the target subgraph. Preserve a target ID for a one-to-one replacement; use stable new IDs only when splitting or joining visible parts requires it.
Do not return text nodes. OCR and all nodes outside the target subgraph are authoritative and must not be replaced, duplicated, or inferred.
For every node return id, role, bbox, confidence, label, extractionHints, and optional zIndex.
extractionHints must be an array of strings; return [] when there are none.
confidence must be between 0 and 1.
role must be one of: background | text-backing | foreground-object | connector | compound-group | decoration.
For every relation return id, kind, from, to, and confidence. relation kind must be one of: belongs-to | connected-to | occludes | in-front-of | behind.
Reference only node IDs present in this regional response. Labels are audit-only; make decisions only from visible geometry, roles, relations, confidence, zIndex, and extractionHints.`;
}
