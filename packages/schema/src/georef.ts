import { z } from 'zod';
import { Mat4 } from './common';

export const GEOREF_SCHEMA = 'aio.georef/1' as const;
// zod 4 numbers already reject NaN and Infinity, so no .finite() (it is deprecated).
const Finite = z.number();

/**
 * Where a model sits on the ground: a CRS, the anchor in it, the model axes and the matrix from
 * model space to the CRS, with the status of every part so a provisional placement is never taken
 * for a surveyed one.
 */
export const Georef = z
  .object({
    schema: z.literal(GEOREF_SCHEMA),
    crs: z.union([
      z.object({ epsg: z.number().int().positive() }).strict(),
      z.object({ wkt: z.string().min(10).max(20000) }).strict(),
    ]),
    anchor: z.tuple([Finite, Finite, Finite]),
    axes: z.literal('x-east,y-up,z-south'),
    units: z.literal('m'),
    modelToCrs: Mat4,
    heading: z
      .object({ deg: Finite, status: z.enum(['measured', 'user', 'assumed-grid']) })
      .strict(),
    scale: z
      .object({
        factor: z.number().positive(),
        status: z.enum(['measured', 'reference', 'user', 'provisional']),
      })
      .strict(),
    horizontal: z
      .object({
        status: z.enum(['surveyed', 'from-source', 'user', 'unplaced']),
        accuracyM: z.number().nonnegative().optional(),
      })
      .strict(),
    vertical: z
      .object({
        datum: z.string().min(1).max(120),
        status: z.enum(['from-source', 'user', 'unknown']),
      })
      .strict()
      .refine(
        (v) => (v.datum.toLowerCase() === 'unknown') === (v.status === 'unknown'),
        'An unknown datum has status unknown.',
      ),
    provenance: z
      .object({
        by: z.enum(['engineer', 'place-model', 'import', 'compat']),
        runId: z.string().max(80).optional(),
        source: z.string().max(300).optional(),
      })
      .strict(),
    deviation: z
      .object({
        rmsM: z.number().nonnegative(),
        p95M: z.number().nonnegative(),
        samples: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Georef = z.infer<typeof Georef>;

/** Whether a mesh layer is placed on the ground, still needs placing, or is a first guess. */
export const Placement = z.enum(['placed', 'needed', 'provisional']);
export type Placement = z.infer<typeof Placement>;
