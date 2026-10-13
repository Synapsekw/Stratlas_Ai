import { z } from 'zod';
import { Id, IsoTime, ProjectPath } from './common';
import { PhotoRun, PhotoRunId } from './photogrammetry';

export const TRASH_SCHEMA = 'aio.trash/1';

/** What a removal names: a manifest layer, a photogrammetry run, or a survey date. */
export const RemoveTarget = z.union([
  z.object({ layer: Id }).strict(),
  z.object({ run: PhotoRunId }).strict(),
  z.object({ capture: Id }).strict(),
]);

/** Why a thing is in a plan: asked for, used by, made by, or filed under another removed thing. */
export const RemoveWhy = z.union([
  z.literal('asked'),
  z.object({ usedBy: z.string().min(1) }).strict(),
  z.object({ madeBy: z.string().min(1) }).strict(),
  z.object({ filedUnder: z.string().min(1) }).strict(),
]);

export const KeptCapture = z
  .object({ id: Id, by: z.enum(['volume', 'qa', 'measurement']) })
  .strict();

export const RemovalPlan = z
  .object({
    layers: z.array(
      z.object({ id: Id, name: z.string(), kind: z.string(), why: RemoveWhy }).strict(),
    ),
    runs: z.array(
      z
        .object({
          id: PhotoRunId,
          /** null: the run folder has no readable `run.json`. */
          status: PhotoRun.shape.status.nullable(),
          why: RemoveWhy,
        })
        .strict(),
    ),
    changes: z.array(
      z.object({ id: z.string().min(1), name: z.string(), why: RemoveWhy }).strict(),
    ),
    tilesets: z.array(z.string()),
    surfaces: z.array(z.string()),
    /** `detections/<file>.json` paths naming a removed layer. */
    detections: z.array(ProjectPath),
    jobs: z.array(z.string()),
    captures: z.array(Id),
    keptCaptures: z.array(KeptCapture),
    /** Folders a removed run reads in place: never moved. */
    keptOutside: z.array(z.string()),
    /** Project-relative paths that move to `.trash/`. */
    files: z.array(ProjectPath),
    bytes: z.number().int().nonnegative(),
    refused: z.string().optional(),
    touches: z
      .object({ issues: z.number().int().nonnegative(), walkPins: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

/** `.trash/<entry>/removed.json` (`aio.trash/1`): what one removal moved, for a restore by hand. */
export const TrashRecord = z
  .object({
    schema: z.literal(TRASH_SCHEMA),
    at: IsoTime,
    targets: z.array(RemoveTarget).min(1),
    plan: RemovalPlan,
    /** The manifest as it was, a file in the same entry (`manifest.before.json`). */
    manifestBefore: z.string().min(1).max(260),
  })
  .strict();

export type RemoveTarget = z.infer<typeof RemoveTarget>;
export type RemoveWhy = z.infer<typeof RemoveWhy>;
export type KeptCapture = z.infer<typeof KeptCapture>;
export type RemovalPlan = z.infer<typeof RemovalPlan>;
export type TrashRecord = z.infer<typeof TrashRecord>;

/** A plan with nothing in it (the start of `planRemoval`, and a refusal's body). */
export function emptyRemovalPlan(): RemovalPlan {
  return {
    layers: [],
    runs: [],
    changes: [],
    tilesets: [],
    surfaces: [],
    detections: [],
    jobs: [],
    captures: [],
    keptCaptures: [],
    keptOutside: [],
    files: [],
    bytes: 0,
    touches: { issues: 0, walkPins: 0 },
  };
}
