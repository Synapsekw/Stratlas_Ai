import { z } from 'zod';
import { Id, IsoTime, Vec3 } from './common';
import { Crs } from './manifest';

/**
 * What the Properties dialog of a dataset shows (`layer:info`), read by main from the layer's own
 * files: each file with its size, the total, how many items or points, where it lies in the local
 * frame (data-conventions section 1), the project CRS, and when its main file was written.
 */
export const LayerInfo = z.object({
  layerId: Id,
  name: z.string().min(1),
  kind: z.string().min(1),
  files: z.array(
    z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative().nullable() }),
  ),
  bytes: z.number().int().nonnegative().nullable(),
  count: z.number().int().nonnegative().nullable(),
  countKind: z.enum(['items', 'points', 'features']).nullable(),
  extent: z.object({ min: Vec3, max: Vec3 }).nullable(),
  crs: Crs,
  /** Creation time of the main file on disk (layers carry no import time). */
  importedAt: IsoTime.nullable(),
  /** Project-relative path of the file Reveal in folder shows. */
  mainFile: z.string().nullable(),
});

export const LayerExportResult = z.object({
  ok: z.literal(true),
  written: z.number().int().nonnegative(),
  /** Names of the layers not exported because their folder was already there. */
  skipped: z.array(z.string()),
  cancelled: z.boolean(),
});

export type LayerInfo = z.infer<typeof LayerInfo>;
export type LayerExportResult = z.infer<typeof LayerExportResult>;
