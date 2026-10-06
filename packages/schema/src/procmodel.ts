import { z } from 'zod';
import { Id, IsoTime, Vec2, Vec3 } from './common';

/**
 * Procedural models (M8, BLD-11): massing and plant primitives made from a DXF drawing, a point
 * cloud fit, the agent or by hand, built by the TypeScript mesher into a GLB with one node per part
 * (named by tag). One file per model, `<project>/models/<id>.procmodel.json` (`aio.procmodel/1`,
 * data-conventions section 15). Coordinates are the project local frame in metres (x east, y up,
 * z south); footprints are `[x, z]` pairs. Every part starts as a draft a person accepts.
 */

export const PROCMODEL_SCHEMA = 'aio.procmodel/1' as const;
/** Folder of procedural models (and their built GLBs) inside a project. */
export const PROCMODEL_DIR = 'models';

/** A file-name-safe model id: `<project>/models/<id>.procmodel.json`. */
export const ProcModelId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/, 'A model id is a plain file name.');

export const PartStatus = z.enum(['draft', 'accepted', 'rejected']);

export const ProcPartKind = z.enum(['extrusion', 'cylinder', 'box', 'pipe', 'sphere']);

/** Where a part came from. */
export const PartOrigin = z.discriminatedUnion('by', [
  z
    .object({
      by: z.literal('fit'),
      /** RMS distance of the inlier points to the primitive, metres. */
      residualM: z.number().nonnegative(),
      inliers: z.number().int().nonnegative(),
      /** Share of the cluster's points that are inliers, 0 to 1. */
      inlierShare: z.number().min(0).max(1).optional(),
      runId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      by: z.literal('drawing'),
      /** Project-relative drawing file, its DXF layer and entity handle. */
      file: z.string().optional(),
      layer: z.string().optional(),
      entity: z.string().optional(),
    })
    .strict(),
  z
    .object({
      by: z.literal('agent'),
      runId: z.string().optional(),
      model: z.string().optional(),
    })
    .strict(),
  z.object({ by: z.literal('manual'), author: z.string().optional() }).strict(),
]);

const Positive = z.number().positive();

const partBase = {
  id: z.string().min(1).max(128),
  /** Display name; the GLB node is named by `tag` when given, else by `name`, else by `id`. */
  name: z.string().max(200).optional(),
  /** Plant tag (`T-101`): issues, tags and part matching across dates use it. */
  tag: z.string().max(80).optional(),
  /** What the part is (`tank`, `vessel`, `building`, `skid`, `rack`, `pipe`). */
  class: z.string().max(40).optional(),
  status: PartStatus,
  confidence: z.number().min(0).max(1).optional(),
  origin: PartOrigin,
};

export const ProcPart = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('extrusion'),
      ...partBase,
      /** Footprint polygon `[x, z]`, counter-clockwise seen from above. */
      footprint: z.array(Vec2).min(3),
      /** Height of the base (y) and the extrusion height, metres. */
      baseY: z.number(),
      height: Positive,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cylinder'),
      ...partBase,
      /** Centre of the base, with a vertical axis (tanks and vessels). */
      base: Vec3,
      radius: Positive,
      height: Positive,
      roof: z.enum(['flat', 'cone', 'dome']).optional(),
      roofHeight: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('box'),
      ...partBase,
      /** Centre of the base; size along x, y (height) and z before the turn about the vertical. */
      base: Vec3,
      size: z.tuple([Positive, Positive, Positive]),
      yawDeg: z.number().min(-180).max(180).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pipe'),
      ...partBase,
      /** Centreline points. */
      points: z.array(Vec3).min(2),
      diameter: Positive,
    })
    .strict(),
  z
    .object({
      kind: z.literal('sphere'),
      ...partBase,
      center: Vec3,
      radius: Positive,
    })
    .strict(),
]);

export const ProcModel = z
  .object({
    schema: z.literal(PROCMODEL_SCHEMA),
    id: ProcModelId,
    name: z.string().min(1).max(200),
    createdAt: IsoTime,
    updatedAt: IsoTime,
    /** The capture the model shows (built mesh layers get it as `capture`). */
    capture: Id.optional(),
    /** Drawings and point cloud layers the parts came from. */
    sources: z
      .array(
        z
          .object({ kind: z.enum(['drawing', 'pointcloud', 'plan']), ref: z.string().min(1) })
          .strict(),
      )
      .optional(),
    parts: z.array(ProcPart),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.parts.forEach((p, i) => {
      if (seen.has(p.id))
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate part id "${p.id}"`,
          path: ['parts', i, 'id'],
        });
      seen.add(p.id);
    });
  });

/** One line of `model:list`. */
export const ProcModelSummary = z.object({
  id: ProcModelId,
  name: z.string(),
  parts: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  updatedAt: z.string(),
  /** Mesh layer built from the model, when there is one. */
  layer: Id.optional(),
});

export type PartStatus = z.infer<typeof PartStatus>;
export type ProcPartKind = z.infer<typeof ProcPartKind>;
export type PartOrigin = z.infer<typeof PartOrigin>;
export type ProcPart = z.infer<typeof ProcPart>;
export type ProcModel = z.infer<typeof ProcModel>;
export type ProcModelSummary = z.infer<typeof ProcModelSummary>;
