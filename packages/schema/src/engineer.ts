import { z } from 'zod';
import { Assembly, ModelFamily } from './assemblies';
import { IsoTime, Vec2, Vec3 } from './common';

/**
 * Engineering model run contracts: the setup a person chooses, the bounded proposal the AI returns
 * (`EngineerProposal`, parameters only, never geometry) and the run record kept under
 * `engineering/<run>/run.json` (`aio.engineer-run/1`).
 */

export const Detail = z.enum(['fast', 'standard', 'detailed']);
export type Detail = z.infer<typeof Detail>;

/** Per-detail budgets: generated triangles, AI cost cap in US dollars, AI passes. */
export const DETAIL_BUDGETS = {
  fast: { triangles: 150_000, costUsd: 0.5, passes: 1 },
  standard: { triangles: 400_000, costUsd: 2, passes: 2 },
  detailed: { triangles: 900_000, costUsd: 5, passes: 3 },
} as const satisfies Record<Detail, { triangles: number; costUsd: number; passes: number }>;

/** An engineering run id; the run folder is `engineering/<run>/`. */
export const RunId = z.string().regex(/^run-[a-z0-9-]{1,60}$/);

/** A layer reference in a run setup or job params. */
const LayerRef = z.object({ layer: z.string().min(1).max(128) }).strict();

/**
 * The region of interest, in project local metres: a circle around a plan centre or a box. Lives
 * here rather than in modelEvidence.ts so the two modules do not import each other.
 */
export const EvidenceRegion = z.union([
  z.object({ centre: Vec2, radiusM: z.number().positive().max(2000) }).strict(),
  z.object({ min: Vec3, max: Vec3 }).strict(),
]);
export type EvidenceRegion = z.infer<typeof EvidenceRegion>;

export const EngineerStage = z.enum([
  'inspect',
  'estimate',
  'identify',
  'generate',
  'validate',
  'review',
]);

/**
 * A proposal parameter value: no arrays, no objects, so the AI cannot hand back geometry. zod 4
 * numbers already refuse Infinity and NaN.
 */
const Scalar = z.union([z.number(), z.string().max(80), z.boolean()]);

export const ProposalComponent = z
  .object({
    role: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    /** Validated against `AssemblyKind` by the assembler; unknown kinds become unresolved. */
    kind: z.string().max(40),
    count: z.number().int().min(0).max(64),
    /**
     * What the length values in `params` are: `ratio` of the asset height (scale unknown) or `m`
     * (metres, scale known). Required so the assembler never guesses.
     */
    units: z.enum(['ratio', 'm']),
    params: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/), Scalar)
      .refine((p) => Object.keys(p).length <= 24, 'At most 24 parameters per component.'),
    /** Heights as a ratio of the asset height (lights, platforms). */
    levels: z.array(z.number().min(0).max(1.2)).max(16).optional(),
    imageIds: z.array(z.string().max(40)).max(24),
    observed: z.boolean(),
    description: z.string().max(300).optional(),
  })
  .strict();

export const EngineerProposal = z
  .object({
    family: z.object({ value: ModelFamily, reasons: z.array(z.string().max(200)).max(8) }).strict(),
    identity: z
      .object({
        sameAsset: z.boolean(),
        conflicts: z
          .array(
            z
              .object({
                imageIds: z.array(z.string().max(40)).max(40),
                reason: z.string().max(300),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    components: z.array(ProposalComponent).max(120),
    unresolved: z.array(z.string().max(200)).max(40),
    notes: z.string().max(1000),
  })
  .strict();

export const EngineerSetup = z
  .object({
    sources: z
      .object({
        clouds: z.array(LayerRef).max(4),
        meshes: z.array(LayerRef).max(2),
        photos: z.array(z.object({ path: z.string().min(1).max(1000) }).strict()).max(400),
      })
      .strict(),
    region: EvidenceRegion.optional(),
    family: z.union([z.literal('auto'), ModelFamily]),
    scope: z.enum(['asset', 'asset-and-surroundings']),
    detail: Detail,
    reference: z
      .object({
        what: z.enum(['height', 'diameter', 'other']),
        valueM: z.number().positive().max(1000),
        label: z.string().max(80).optional(),
      })
      .strict()
      .optional(),
    placement: z.enum(['from-source', 'anchor', 'unplaced']),
    /** Project local anchor point; required when `placement` is `anchor`. */
    anchor: Vec3.optional(),
  })
  .strict()
  .refine((s) => s.placement !== 'anchor' || s.anchor !== undefined, {
    message: 'Placement at an anchor needs the anchor point.',
    path: ['anchor'],
  });

const StageState = z
  .object({
    status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled', 'skipped']),
    hash: z.string().max(80).optional(),
    message: z.string().max(500).optional(),
    output: z.string().max(300).optional(),
  })
  .strict();

const OverrideKey = z.string().min(1).max(80);
/** The person's corrections of a run, bounded (see `UserOverrides` in `@aio/modelling`). */
export const RunOverrides = z
  .object({
    params: z
      .record(
        OverrideKey,
        z.record(OverrideKey, z.union([z.number(), z.string().max(200), z.boolean()])),
      )
      .refine((p) => Object.keys(p).length <= 400, 'At most 400 corrected components.'),
    counts: z
      .record(OverrideKey, z.number().int().min(0).max(64))
      .refine((p) => Object.keys(p).length <= 100, 'At most 100 corrected counts.'),
    levels: z
      .record(OverrideKey, z.array(z.number()).max(32))
      .refine((p) => Object.keys(p).length <= 100, 'At most 100 corrected levels.'),
    removed: z.array(OverrideKey).max(400),
    added: z.array(Assembly).max(120),
  })
  .strict();
export type RunOverrides = z.infer<typeof RunOverrides>;

export const EngineerRun = z
  .object({
    schema: z.literal('aio.engineer-run/1'),
    id: RunId,
    modelId: z.string().min(1).max(80),
    createdAt: IsoTime,
    setup: EngineerSetup,
    /** Only the stages reached so far are recorded. */
    stages: z.partialRecord(EngineerStage, StageState),
    usage: z
      .object({
        costUsd: z.number().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    reconstruction: z.enum(['not-needed', 'queued', 'done', 'unavailable']).optional(),
    /**
     * The person's corrections the model was last assembled with (`UserOverrides` of
     * `@aio/modelling`), so a reopened run rebuilds with them, never without.
     */
    user: RunOverrides.optional(),
    /** Evidence images the person dropped (an identity conflict): never sent again in this run. */
    excludedImages: z
      .array(z.string().regex(/^img-[a-z0-9-]{1,40}$/))
      .max(64)
      .optional(),
  })
  .strict();

export type ProposalComponent = z.infer<typeof ProposalComponent>;
export type EngineerProposal = z.infer<typeof EngineerProposal>;
export type EngineerSetup = z.infer<typeof EngineerSetup>;
export type EngineerRun = z.infer<typeof EngineerRun>;
export type EngineerStage = z.infer<typeof EngineerStage>;
