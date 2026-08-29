import { z } from "zod";

export type CanvasSize = { width: number; height: number };
export type NormalizedBBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SceneRole =
  | "background"
  | "text"
  | "text-backing"
  | "foreground-object"
  | "connector"
  | "compound-group"
  | "decoration";
export type SceneRelationKind =
  | "belongs-to"
  | "connected-to"
  | "carries-text"
  | "occludes"
  | "in-front-of"
  | "behind";
export type SceneNode = {
  id: string;
  role: SceneRole;
  bbox: NormalizedBBox;
  confidence: number;
  zIndex?: number;
  label: string;
  extractionHints: string[];
};
export type SceneRelation = {
  id: string;
  kind: SceneRelationKind;
  from: string;
  to: string;
  confidence: number;
};
export type SceneGraph = {
  graphVersion: 1;
  canvas: CanvasSize;
  nodes: SceneNode[];
  relations: SceneRelation[];
};

export const CanvasSizeSchema = z
  .object({
    width: z.number().int().safe().positive(),
    height: z.number().int().safe().positive(),
  })
  .strict();

export const NormalizedBBoxSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .superRefine((bbox, context) => {
    if (bbox.x + bbox.width > 1) {
      context.addIssue({
        code: "custom",
        message: "x + width must not exceed 1",
        path: ["width"],
      });
    }
    if (bbox.y + bbox.height > 1) {
      context.addIssue({
        code: "custom",
        message: "y + height must not exceed 1",
        path: ["height"],
      });
    }
  });

export const SceneRoleSchema = z.enum([
  "background",
  "text",
  "text-backing",
  "foreground-object",
  "connector",
  "compound-group",
  "decoration",
]);

export const SceneRelationKindSchema = z.enum([
  "belongs-to",
  "connected-to",
  "carries-text",
  "occludes",
  "in-front-of",
  "behind",
]);

export const SceneNodeSchema = z
  .object({
    id: z.string().min(1),
    role: SceneRoleSchema,
    bbox: NormalizedBBoxSchema,
    confidence: z.number().finite().min(0).max(1),
    zIndex: z.number().int().safe().optional(),
    label: z.string(),
    extractionHints: z.array(z.string()),
  })
  .strict();

export const SceneRelationSchema = z
  .object({
    id: z.string().min(1),
    kind: SceneRelationKindSchema,
    from: z.string().min(1),
    to: z.string().min(1),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

export const SceneGraphSchema = z
  .object({
    graphVersion: z.literal(1),
    canvas: CanvasSizeSchema,
    nodes: z.array(SceneNodeSchema),
    relations: z.array(SceneRelationSchema),
  })
  .strict()
  .superRefine((graph, context) => {
    const nodeIds = new Set<string>();
    for (const [index, node] of graph.nodes.entries()) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate scene node id: ${node.id}`,
          path: ["nodes", index, "id"],
        });
      }
      nodeIds.add(node.id);
    }

    const relationIds = new Set<string>();
    for (const [index, relation] of graph.relations.entries()) {
      if (relationIds.has(relation.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate scene relation id: ${relation.id}`,
          path: ["relations", index, "id"],
        });
      }
      relationIds.add(relation.id);

      for (const endpoint of ["from", "to"] as const) {
        if (!nodeIds.has(relation[endpoint])) {
          context.addIssue({
            code: "custom",
            message: `relation endpoint does not reference a scene node: ${relation[endpoint]}`,
            path: ["relations", index, endpoint],
          });
        }
      }

      if (relation.kind === "carries-text") {
        const from = graph.nodes.find((node) => node.id === relation.from);
        const to = graph.nodes.find((node) => node.id === relation.to);
        if (from?.role !== "text-backing" || to?.role !== "text") {
          context.addIssue({
            code: "custom",
            message: "carries-text must point from text-backing to text",
            path: ["relations", index, "kind"],
          });
        }
      }
    }

    const backgrounds = graph.nodes.filter(
      (node) => node.role === "background",
    );
    if (backgrounds.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "scene graph must contain exactly one background node",
        path: ["nodes"],
      });
    }
  });
