import { z } from 'zod';

/**
 * Where a procedural part or engineering assembly came from. Its own module so `procmodel.ts` and
 * `assemblies.ts` both use it without importing each other at load; `procmodel.ts` re-exports it.
 */
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
  /** Made by an engineering model run (`aio.procmodel/2`). */
  z
    .object({
      by: z.literal('engineer'),
      runId: z.string().min(1).max(80),
      /** The AI model that proposed it, when one did. */
      model: z.string().max(120).optional(),
    })
    .strict(),
]);

export type PartOrigin = z.infer<typeof PartOrigin>;
