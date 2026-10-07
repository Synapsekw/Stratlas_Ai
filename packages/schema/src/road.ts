import { z } from 'zod';
import { HexColor, Vec3, err, ok, type Result } from './common';

export const ROAD_SCHEMA = 'aio.road/1' as const;

/** A value under each ASTM D6433 severity assumption (null where it cannot be computed). */
const BySeverity = z.object({
  low: z.number().nullable(),
  medium: z.number().nullable(),
  high: z.number().nullable(),
});

export const PciRating = z.object({ min: z.number(), label: z.string().min(1), color: HexColor });

export const PciSection = z.object({
  fromKm: z.number(),
  toKm: z.number(),
  pavementM2: z.number().nullable(),
  pci: BySeverity,
});

export const PciUnit = z.object({
  id: z.string().min(1),
  pavementM2: z.number().nonnegative(),
  pci: BySeverity,
  km: z.number(),
  /** Chainage the unit runs from and to (units along the road, `pci.layout: 'chainage'`). */
  fromKm: z.number().optional(),
  toKm: z.number().optional(),
  /** Deducts under the headline severity. */
  deducts: z.array(
    z.object({ distress: z.string().min(1), densityPct: z.number(), deduct: z.number() }),
  ),
  /** Grid cells [i, j] the unit covers (see `pci.grid`); empty for units along the road. */
  cells: z.array(z.tuple([z.number().int(), z.number().int()])),
});

/** How sample units are laid out: square cells of `pci.grid` (as delivered) or along the road. */
export const PciLayout = z.enum(['grid', 'chainage']);

export const DensityCell = z.object({
  i: z.number().int(),
  j: z.number().int(),
  pavementM2: z.number().nonnegative(),
  defects: z.number().int().nonnegative(),
  defectM2: z.number().nonnegative(),
  coverPct: z.number().nonnegative(),
});

/**
 * `road.json` (`aio.road/1`) beside a road survey's manifest: the centreline with chainage, the
 * PCI sample units and sections, density grids and GeoJSON overlays. Grids are aligned to the
 * project CRS: cell (i, j) of size c spans local x `origin[0] + j c` to `+ c` and z
 * `origin[2] + i c` to `+ c` (data-conventions section 9).
 */
export const RoadModel = z
  .object({
    schema: z.literal(ROAD_SCHEMA),
    name: z.string().min(1),
    centreline: z.object({
      /** Local frame, in chainage order. */
      points: z.array(Vec3).min(2),
      chainageKm: z.array(z.number()),
      lengthKm: z.number().nonnegative(),
    }),
    pci: z.object({
      standard: z.string().min(1),
      severities: z.array(z.string()),
      headline: z.enum(['low', 'medium', 'high']),
      network: BySeverity,
      coveragePct: z.number().optional(),
      /** Rating classes, highest `min` first. */
      ratings: z.array(PciRating).min(1),
      /** Unit layout (absent: grid). For units along the road `grid.cellM` is the unit length. */
      layout: PciLayout.optional(),
      grid: z.object({ cellM: z.number().positive(), origin: Vec3 }),
      sections: z.array(PciSection),
      units: z.array(PciUnit),
    }),
    density: z.object({
      gridOrigin: Vec3,
      /** Cell size in metres ("10", "20", "50") to cells with pavement. */
      sizes: z.record(z.string().regex(/^\d+$/), z.array(DensityCell)),
    }),
    /** Project-relative GeoJSON files (lon/lat) for map overlays, by role. */
    overlays: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.centreline.chainageKm.length !== r.centreline.points.length) {
      ctx.addIssue({
        code: 'custom',
        message: `The centreline needs one chainage per vertex (${r.centreline.points.length} vertices, ${r.centreline.chainageKm.length} chainages)`,
        path: ['centreline', 'chainageKm'],
      });
    }
    if ((r.pci.layout ?? 'grid') === 'grid') {
      const i = r.pci.units.findIndex((u) => u.cells.length === 0);
      if (i >= 0)
        ctx.addIssue({
          code: 'custom',
          message: 'A grid sample unit needs at least one cell',
          path: ['pci', 'units', i, 'cells'],
        });
    }
  });

export type PciRating = z.infer<typeof PciRating>;
export type PciSection = z.infer<typeof PciSection>;
export type PciUnit = z.infer<typeof PciUnit>;
export type PciLayout = z.infer<typeof PciLayout>;
export type DensityCell = z.infer<typeof DensityCell>;
export type RoadModel = z.infer<typeof RoadModel>;
export type RoadModelInput = z.input<typeof RoadModel>;
export type PciSeverity = RoadModel['pci']['headline'];

/** Parse an untrusted `road.json`, with messages a person can act on. */
export function parseRoadModel(json: unknown): Result<RoadModel> {
  if (typeof json !== 'object' || json === null) return err('Road model is not a JSON object.');
  const version = (json as { schema?: unknown }).schema;
  if (typeof version === 'string' && version !== ROAD_SCHEMA && version.startsWith('aio.road/'))
    return err(
      `Road model was saved by a newer version of Quadrion AI (schema ${version}). Update the app.`,
    );
  const r = RoadModel.safeParse(json);
  if (r.success) return ok(r.data);
  const first = r.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.join('.')}` : '';
  return err(`Road model is invalid${where}: ${first?.message ?? 'unknown error'}`);
}
