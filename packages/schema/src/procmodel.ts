import { z } from 'zod';
import { Assembly, EvidenceInventory, Material, ModelFamily, ScaleRecord } from './assemblies';
import { Id, IsoTime, Vec2, Vec3 } from './common';
import { Georef } from './georef';
import { PartOrigin } from './partOrigin';

// The engineering assemblies and the part origin live in their own modules (no load-time cycle);
// they are part of this contract, so the package index gets them through this file.
export * from './assemblies';
export { PartOrigin } from './partOrigin';

/**
 * Procedural models (M8, BLD-11): massing and plant primitives made from a DXF drawing, a point
 * cloud fit, the agent or by hand, built by the TypeScript mesher into a GLB with one node per part
 * (named by tag). One file per model, `<project>/models/<id>.procmodel.json` (`aio.procmodel/2`,
 * data-conventions section 15). Coordinates are the project local frame in metres (x east, y up,
 * z south); footprints are `[x, z]` pairs. Every part starts as a draft a person accepts.
 *
 * Version 2 adds engineering assemblies, their materials and the run record beside the parts; a
 * `/1` file is read through `readVersioned` (`migrateProcModel1to2` in `versions.ts`) and keeps
 * every part as it was.
 */

export const PROCMODEL_SCHEMA = 'aio.procmodel/2' as const;
/** The first version, still read (and migrated) by this build. */
export const PROCMODEL_V1 = 'aio.procmodel/1' as const;
/** Folder of procedural models (and their built GLBs) inside a project. */
export const PROCMODEL_DIR = 'models';

/** A file-name-safe model id: `<project>/models/<id>.procmodel.json`. */
export const ProcModelId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/, 'A model id is a plain file name.');

export const PartStatus = z.enum(['draft', 'accepted', 'rejected']);

export const ProcPartKind = z.enum(['extrusion', 'cylinder', 'box', 'pipe', 'sphere']);

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
    /** What the engineering model describes; absent on plain procedural models. */
    family: ModelFamily.optional(),
    scope: z.enum(['asset', 'asset-and-surroundings']).optional(),
    materials: z.array(Material).max(64),
    assemblies: z.array(Assembly).max(2000),
    scale: ScaleRecord.optional(),
    georef: Georef.optional(),
    evidence: EvidenceInventory.optional(),
    /** The engineering model run that last wrote the assemblies. */
    run: z
      .object({
        id: z.string().min(1).max(80),
        detail: z.enum(['fast', 'standard', 'detailed']),
      })
      .strict()
      .optional(),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string, path: (string | number)[]) => {
      ctx.addIssue({ code: 'custom', message, path });
    };
    const seen = new Set<string>();
    m.parts.forEach((p, i) => {
      if (seen.has(p.id)) issue(`Duplicate part id "${p.id}"`, ['parts', i, 'id']);
      seen.add(p.id);
    });
    const materials = new Set(m.materials.map((x) => x.id));
    const assemblies = new Set<string>();
    m.assemblies.forEach((a, i) => {
      if (assemblies.has(a.id)) issue(`Duplicate assembly id "${a.id}"`, ['assemblies', i, 'id']);
      else if (seen.has(a.id))
        issue(`Assembly id "${a.id}" is also a part id`, ['assemblies', i, 'id']);
      assemblies.add(a.id);
    });
    const kindOf = new Map(m.assemblies.map((a) => [a.id, a.kind]));
    const parentOf = new Map(m.assemblies.map((a) => [a.id, a.parent]));
    m.assemblies.forEach((a, i) => {
      if (a.parent !== undefined && !assemblies.has(a.parent))
        issue(`Assembly parent "${a.parent}" does not exist`, ['assemblies', i, 'parent']);
      // walk the parent chain: a repeat is a cycle (a self-parent included)
      const visited = new Set<string>([a.id]);
      for (let up = a.parent; up !== undefined; up = parentOf.get(up)) {
        if (visited.has(up)) {
          issue(`Assembly "${a.id}" is in a parent cycle`, ['assemblies', i, 'parent']);
          break;
        }
        visited.add(up);
      }
      if (a.kind === 'band' && kindOf.get(a.params.shaft) !== 'shaft')
        issue(`Band shaft "${a.params.shaft}" is not a shaft in the model`, [
          'assemblies',
          i,
          'params',
          'shaft',
        ]);
      const ringed =
        a.kind === 'ringPlatform'
          ? a.params.shaft
          : a.kind === 'guardrail' && !Array.isArray(a.params.path)
            ? a.params.path.shaft
            : undefined;
      if (ringed !== undefined && kindOf.get(ringed) !== 'shaft')
        issue(
          `${a.kind === 'ringPlatform' ? 'Platform' : 'Guardrail'} shaft "${ringed}" is not a shaft in the model`,
          ['assemblies', i, 'params', ...(a.kind === 'ringPlatform' ? [] : ['path']), 'shaft'],
        );
      if (a.material !== undefined && !materials.has(a.material))
        issue(`Material "${a.material}" is not in the model`, ['assemblies', i, 'material']);
      if (a.kind === 'band' && !materials.has(a.params.material))
        issue(`Material "${a.params.material}" is not in the model`, [
          'assemblies',
          i,
          'params',
          'material',
        ]);
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
export type ProcPart = z.infer<typeof ProcPart>;
export type ProcModel = z.infer<typeof ProcModel>;
export type ProcModelSummary = z.infer<typeof ProcModelSummary>;
