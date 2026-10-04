import { z } from 'zod';
import { Id, IsoDate, IsoTime, Vec2 } from './common';

/**
 * Stockpile volumes of a volumetric project: `<project>/volumes.json` (`aio.volumes/1`) and the
 * reviewer's toe line corrections in `<project>/edits/boundaries.json` (`aio.boundaries/1`).
 * See docs/architecture/data-conventions.md section 10.
 */

/** The four base surfaces of the Volumetric Survey Kit, default first. */
export const VolumeBaseId = z.enum(['tin', 'plane', 'avg', 'low']);

/** Fill above the base, cut below it and fill minus cut, m³. */
export const FillCut = z.object({ fill: z.number(), cut: z.number(), net: z.number() });

/** One volume per base surface. */
export const BaseVolumes = z.object({ tin: FillCut, plane: FillCut, avg: FillCut, low: FillCut });

/** A ring of `[x, z]` points in the project local frame (x east, z south), metres. */
const RingXZ = z.array(Vec2);

export const PileEpoch = z
  .object({
    captureId: Id,
    areaM2: z.number().nonnegative(),
    topM: z.number(),
    heightM: z.number(),
    surveyErrM3: z.number().optional(),
    /** Share of the toe on the yard floor (the rest leans on a wall or another pile). */
    groundToeFrac: z.number().optional(),
    /** GLB node that holds the pile surface for this date. */
    node: z.string().optional(),
    /** Toe line (pile boundary) on this date. */
    ring: RingXZ,
    volumes: BaseVolumes,
  })
  .loose();

export const StockPile = z
  .object({
    id: Id,
    name: z.string(),
    material: z.string().nullable().optional(),
    status: z.string().optional(),
    /** Centre in the project CRS (easting, northing). */
    centreEN: Vec2.optional(),
    /** Zone over both dates; change is measured inside it. */
    zoneRing: RingXZ,
    /** Surface to surface change from the first to the last date, deadband applied. */
    change: FillCut,
    /** Keyed by the capture `epoch`; a pile may be absent on a date. */
    epochs: z.record(z.string(), PileEpoch),
  })
  .loose();

export const VolumeCapture = z
  .object({
    /** Short key used in `epochs` and by the kit's grids (e1, e2). */
    epoch: Id,
    captureId: Id,
    date: IsoDate,
    label: z.string(),
    /** Layers that show this survey (terrain mesh, ortho); derived from the manifest when absent. */
    layers: z.array(Id).optional(),
  })
  .loose();

/**
 * Where the 10 cm pile grids, the site DSM grids and the coarse volume grids live inside the
 * package. `{id}` is the pile id and `{epoch}` the capture epoch. Absent in packages imported
 * before this field existed; readers then use the kit layout under `legacy/data/`.
 */
export const VolumeGrids = z.object({
  format: z.literal('vs-kit-js'),
  piles: z.string().min(1),
  dsm: z.string().min(1),
  coarse: z.string().min(1).optional(),
});

export const VolumesFile = z
  .object({
    schema: z.literal('aio.volumes/1'),
    source: z.string().optional(),
    densityTPerM3: z.number().positive(),
    swell: z.number().positive().optional(),
    /** Height changes smaller than this are ignored in change figures, m. */
    deadbandM: z.number().nonnegative(),
    defaultBase: VolumeBaseId,
    bases: z.array(z.object({ id: VolumeBaseId, label: z.string() })).min(1),
    /** In survey order, first to last. */
    captures: z.array(VolumeCapture).min(1),
    piles: z.array(StockPile),
    /** Per epoch: net volume per base plus `area_m2`. */
    totals: z.record(z.string(), z.record(z.string(), z.number())),
    pileChange: FillCut,
    siteChange: FillCut.extend({ area_m2: z.number().optional() }).loose(),
    aoi: RingXZ.nullable().optional(),
    excluded: z.array(z.object({ reason: z.string(), ring: RingXZ }).loose()).optional(),
    grids: VolumeGrids.optional(),
  })
  .loose();

/** A toe line corrected by hand, with the volumes recomputed against it. */
export const BoundaryEdit = z
  .object({
    pile: Id,
    epoch: Id,
    /** Corrected toe line, `[x, z]` in the project local frame. */
    ring: RingXZ.min(3),
    volumes: BaseVolumes,
    areaM2: z.number().nonnegative(),
    topM: z.number(),
    heightM: z.number(),
    /** Net volume of the automatic boundary on the default base, for the record. */
    autoNet: z.number(),
    author: z.string().optional(),
    updatedAt: IsoTime,
  })
  .strict();

export const BoundaryEditsFile = z
  .object({ schema: z.literal('aio.boundaries/1'), edits: z.array(BoundaryEdit) })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const e of value.edits) {
      const key = `${e.pile}/${e.epoch}`;
      if (seen.has(key))
        ctx.addIssue({ code: 'custom', message: `Two edits of ${key}`, path: ['edits'] });
      seen.add(key);
    }
  });

export type VolumeBaseId = z.infer<typeof VolumeBaseId>;
export type FillCut = z.infer<typeof FillCut>;
export type BaseVolumes = z.infer<typeof BaseVolumes>;
export type PileEpoch = z.infer<typeof PileEpoch>;
export type StockPile = z.infer<typeof StockPile>;
export type VolumeCapture = z.infer<typeof VolumeCapture>;
export type VolumeGrids = z.infer<typeof VolumeGrids>;
export type VolumesFile = z.infer<typeof VolumesFile>;
export type BoundaryEdit = z.infer<typeof BoundaryEdit>;
export type BoundaryEditsFile = z.infer<typeof BoundaryEditsFile>;
