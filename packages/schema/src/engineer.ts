import { z } from 'zod';
import { ModelFamily } from './assemblies';

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
        clouds: z.array(z.object({ layer: z.string() }).strict()).max(4),
        meshes: z.array(z.object({ layer: z.string() }).strict()).max(2),
        photos: z.array(z.object({ path: z.string().max(1000) }).strict()).max(400),
      })
      .strict(),
    region: z
      .union([
        z
          .object({
            centre: z.tuple([z.number(), z.number()]),
            radiusM: z.number().positive().max(2000),
          })
          .strict(),
        z
          .object({
            min: z.tuple([z.number(), z.number(), z.number()]),
            max: z.tuple([z.number(), z.number(), z.number()]),
          })
          .strict(),
      ])
      .optional(),
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
    anchor: z.tuple([z.number(), z.number(), z.number()]).optional(),
  })
  .strict();

const StageState = z
  .object({
    status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled', 'skipped']),
    hash: z.string().max(80).optional(),
    message: z.string().max(500).optional(),
    output: z.string().max(300).optional(),
  })
  .strict();

export const EngineerRun = z
  .object({
    schema: z.literal('aio.engineer-run/1'),
    id: z.string().regex(/^run-[a-z0-9-]{1,60}$/),
    modelId: z.string().max(80),
    createdAt: z.string(),
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
  })
  .strict();

export type ProposalComponent = z.infer<typeof ProposalComponent>;
export type EngineerProposal = z.infer<typeof EngineerProposal>;
export type EngineerSetup = z.infer<typeof EngineerSetup>;
export type EngineerRun = z.infer<typeof EngineerRun>;
export type EngineerStage = z.infer<typeof EngineerStage>;
