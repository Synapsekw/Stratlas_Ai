import { z } from 'zod';
import { IsoTime } from './common';
import { SitePoint2, SurveyId } from './survey';

/**
 * Hydrology runs (M11 G10, PRD HYD-1 to HYD-3; data-conventions section 30). Each `hydro.flood`,
 * `hydro.flow` or `hydro.rainfall` job writes `survey/hydro/<run>/run.json` (`aio.hydro-run/1`)
 * and the outputs it lists in `files`, paths relative to the run folder. Geometry (GeoJSON, DXF) is
 * in the project CRS (E, N, metres); grids are `aio.grid/1` with a colour view PNG beside them
 * whose `bounds` (west, south, east, north, project CRS) place it on the map. A run reads a
 * prepared surface and never changes it; its `fingerprint` hashes every input (the parameters, the
 * surface's fingerprint, the rainfall file's hash), so a changed surface shows the run as stale.
 */

export const HYDRO_DIR = 'survey/hydro';
export const HYDRO_RUN_FILE = 'run.json';

export const HydroPipeline = z.enum(['hydro.flood', 'hydro.flow', 'hydro.rainfall']);

/** A file of the run folder: a relative path that stays inside it. */
export const HydroRunPath = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, 'A path inside the run folder.')
  .refine((p) => !p.split('/').includes('..'), 'A path inside the run folder.');

/** West, south, east, north in the project CRS. */
const Bounds = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** A colour PNG of a grid and where it lies. */
export const HydroView = z.looseObject({ file: HydroRunPath, bounds: Bounds });

export const HydroRunFiles = z.looseObject({
  /** Flood: the water's edge, GeoJSON polygons (islands as holes) and DXF closed polylines. */
  outline: HydroRunPath.optional(),
  dxf: HydroRunPath.optional(),
  /** Flood: the depth grid (`aio.grid/1`). Rainfall: `maxDepth`, the deepest water of the run. */
  depth: HydroRunPath.optional(),
  maxDepth: HydroRunPath.optional(),
  view: HydroView.optional(),
  /** Flow: the runoff path (a 3D LineString), catchment polygons and stream lines. */
  path: HydroRunPath.optional(),
  catchments: HydroRunPath.optional(),
  streams: HydroRunPath.optional(),
  /** Rainfall: minutes, rain and outflow (m³/s) and stored water (m³). */
  hydrograph: HydroRunPath.optional(),
});

const area = z.number().nonnegative();

export const HydroFloodResults = z.looseObject({
  levelM: z.number(),
  mode: z.enum(['connected', 'all-below']),
  seed: SitePoint2.optional(),
  /** Wet cells times the cell area. */
  areaM2: area,
  /** Depth below the level summed over the wet cells, times the cell area. */
  volumeM3: z.number().nonnegative(),
  maxDepthM: z.number().nonnegative(),
  wetCells: z.number().int().nonnegative(),
  /** The area inside the outline (linear between posts). */
  outlineAreaM2: area.optional(),
  outlineRings: z.number().int().nonnegative().optional(),
});

export const HydroPath = z.looseObject({
  start: SitePoint2,
  end: SitePoint2,
  lengthM: z.number().nonnegative(),
  fallM: z.number(),
  cells: z.number().int().positive(),
  /** True when the path leaves the surface (or the region); its end is then on the edge. */
  leavesSurface: z.boolean(),
});

export const HydroOutlet = z.looseObject({
  /** Where the water leaves the catchment: the snapped cell, or its crossing of the surface's edge. */
  pourPoint: SitePoint2,
  /** The outlet as given (absent for the surface's main outlet). */
  outlet: SitePoint2.optional(),
  /** Cells draining to this outlet first (D8), times the cell area. */
  areaM2: area,
  cells: z.number().int().nonnegative(),
  /** With D-infinity: the upslope area flowing through the outlet cell. */
  contributingAreaM2: area.optional(),
});

export const HydroFlowResults = z.looseObject({
  mode: z.enum(['runoff', 'catchment', 'streams']),
  method: z.enum(['d8', 'dinf']),
  depressions: z.enum(['fill', 'breach']),
  path: HydroPath.optional(),
  outlets: z.array(HydroOutlet).max(100).optional(),
  streamAreaM2: z.number().positive().optional(),
  streamLinks: z.number().int().nonnegative().optional(),
  streamLengthM: z.number().nonnegative().optional(),
});

export const HydroFrame = z.looseObject({
  tMin: z.number().nonnegative(),
  /** The depth grid (`aio.grid/1`) and its colour view. */
  file: HydroRunPath,
  view: HydroRunPath,
  maxDepthM: z.number().nonnegative(),
  wetAreaM2: area,
});

export const HydroRainfallResults = z.looseObject({
  durationMin: z.number().positive(),
  frameMin: z.number().positive(),
  frames: z.array(HydroFrame).max(1000),
  rainM3: z.number().nonnegative(),
  infiltratedM3: z.number().nonnegative(),
  outflowM3: z.number().nonnegative(),
  storedM3: z.number().nonnegative(),
  /** |rain - infiltrated - outflow - stored| over the rain, percent. */
  massErrorPct: z.number().nonnegative(),
  peakOutflowM3s: z.number().nonnegative(),
  peakAtMin: z.number().nonnegative(),
  finalOutflowM3s: z.number().nonnegative(),
  maxDepthM: z.number().nonnegative(),
  steps: z.number().int().nonnegative(),
  areaM2: area,
});

const base = {
  schema: z.literal('aio.hydro-run/1'),
  id: SurveyId,
  jobId: z.string().min(1).max(200),
  computedAt: IsoTime,
  surface: z.looseObject({
    id: SurveyId,
    name: z.string().max(400),
    fingerprint: z.string().max(200),
  }),
  /** The job's parameters as run. */
  params: z.record(z.string(), z.unknown()),
  /** The cell the run computed on, metres. */
  cellM: z.number().positive(),
  files: HydroRunFiles,
  /** SHA-256 of the canonical JSON of every input (`sha256:` and hex). */
  fingerprint: z.string().min(1).max(200),
  /** A model that has not met its quality target ships its runs as a preview (decision 3). */
  preview: z.boolean().optional(),
  notes: z.array(z.string().max(1000)).max(20).optional(),
};

/** `survey/hydro/<run>/run.json`. */
export const HydroRun = z.discriminatedUnion('pipeline', [
  z.looseObject({ ...base, pipeline: z.literal('hydro.flood'), results: HydroFloodResults }),
  z.looseObject({ ...base, pipeline: z.literal('hydro.flow'), results: HydroFlowResults }),
  z.looseObject({ ...base, pipeline: z.literal('hydro.rainfall'), results: HydroRainfallResults }),
]);

export type HydroPipeline = z.infer<typeof HydroPipeline>;
export type HydroView = z.infer<typeof HydroView>;
export type HydroRunFiles = z.infer<typeof HydroRunFiles>;
export type HydroFloodResults = z.infer<typeof HydroFloodResults>;
export type HydroFlowResults = z.infer<typeof HydroFlowResults>;
export type HydroRainfallResults = z.infer<typeof HydroRainfallResults>;
export type HydroFrame = z.infer<typeof HydroFrame>;
export type HydroOutlet = z.infer<typeof HydroOutlet>;
export type HydroPath = z.infer<typeof HydroPath>;
export type HydroRun = z.infer<typeof HydroRun>;
