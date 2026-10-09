import { z } from 'zod';
import { Id, IsoTime } from './common';
import { DesignId } from './designs';
import { HaulAnalyseParams } from './jobs';
import { SurveyId } from './survey';

/**
 * Haul-road compliance runs (M11 G11, PRD HRD-1; data-conventions section 30): `haul.analyse`
 * writes `survey/haul/<run>/run.json` (`aio.haul-run/1`) and `haul.geojson` beside it. Read by
 * the app with `survey:readHaulRuns`; never written by the app. Values are SI: metres, and
 * percent for grades, cross falls and superelevation. Loose objects: the pipeline may add keys.
 */

export const HAUL_DIR = 'survey/haul';

/** The result of one check at a station: `n/a` when no limit applies there. */
export const HaulCheckStatus = z.enum(['pass', 'fail', 'n/a', 'no-data']);
export const HaulStationStatus = z.enum(['pass', 'fail', 'no-data']);
export const HaulCheck = z.enum([
  'width',
  'grade',
  'crossFall',
  'superelevation',
  'bermLeft',
  'bermRight',
]);

/** A berm (`berm`), a face that keeps rising (`bank`) or ground that falls away (`drop`). */
export const HaulBerm = z.looseObject({
  kind: z.enum(['berm', 'bank', 'drop']),
  /** Crest above the road edge, metres (0 for a drop). */
  heightM: z.number().nullable(),
  /** Edge to outer toe, metres; null when the outer face does not come back down. */
  widthM: z.number().nullable(),
  /** Offset of the crest from the centreline, metres. */
  crestOffsetM: z.number().nullable(),
});

export const HaulStation = z.looseObject({
  chainageM: z.number(),
  station: z.number(),
  /** `1+234.567` with the alignment's start station and equations. */
  stationLabel: z.string().max(40),
  e: z.number(),
  n: z.number(),
  /** Surface height on the centreline; null without data. */
  z: z.number().nullable(),
  /** Centreline curvature, 1/m, positive turning right. */
  curvature: z.number().nullable(),
  radiusM: z.number().nullable(),
  /** The direction of the curve; null on a tangent. */
  turn: z.enum(['left', 'right']).nullable(),
  widthM: z.number().nullable(),
  edgeLeftM: z.number().nullable(),
  edgeRightM: z.number().nullable(),
  /** Positive uphill along the chainage. */
  gradePct: z.number().nullable(),
  /** Fall from the centreline to the edge (positive falls, negative rises). */
  crossFallLeftPct: z.number().nullable(),
  crossFallRightPct: z.number().nullable(),
  shape: z.enum(['crown', 'one-way', 'flat', 'trough']).nullable(),
  /** On curves: the one-way slope, positive with the inside of the curve lower. */
  superelevationPct: z.number().nullable(),
  bermLeft: HaulBerm.nullable(),
  bermRight: HaulBerm.nullable(),
  checks: z.record(HaulCheck, HaulCheckStatus),
  status: HaulStationStatus,
});

/** A run of consecutive stations failing one check. */
export const HaulStretch = z.looseObject({
  check: HaulCheck,
  fromChainageM: z.number(),
  toChainageM: z.number(),
  fromStation: z.string().max(40),
  toStation: z.string().max(40),
  stations: z.number().int().positive(),
});

/** `survey/haul/<run>/run.json`. */
export const HaulRun = z.looseObject({
  schema: z.literal('aio.haul-run/1'),
  id: SurveyId,
  jobId: z.string().max(200).optional(),
  /** The `haul.analyse` parameters as given: the limits used live here. */
  params: HaulAnalyseParams,
  surface: z.looseObject({
    id: SurveyId,
    name: z.string().max(200),
    /** The prepared surface's fingerprint when the run was made (stale when it differs). */
    fingerprint: z.string().max(200),
    cellM: z.number().positive(),
    capture: Id.optional(),
  }),
  centreline: z.looseObject({
    source: z.enum(['drawn', 'alignment', 'linework']),
    name: z.string().max(400),
    lengthM: z.number().nonnegative(),
    design: DesignId.optional(),
    layer: DesignId.optional(),
    /** The design layer file's hash when the run was made. */
    sha256: z.string().max(80).optional(),
  }),
  intervalM: z.number().positive(),
  stations: z.array(HaulStation).max(100_000),
  stretches: z.array(HaulStretch).max(100_000),
  summary: z.looseObject({
    stations: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    noData: z.number().int().nonnegative(),
  }),
  /** The GeoJSON beside the run (project CRS, E, N, Z). */
  geojson: z.string().max(200),
  fingerprint: z.string().max(200),
  computedAt: IsoTime,
});

export type HaulCheckStatus = z.infer<typeof HaulCheckStatus>;
export type HaulStationStatus = z.infer<typeof HaulStationStatus>;
export type HaulCheck = z.infer<typeof HaulCheck>;
export type HaulBerm = z.infer<typeof HaulBerm>;
export type HaulStation = z.infer<typeof HaulStation>;
export type HaulStretch = z.infer<typeof HaulStretch>;
export type HaulRun = z.infer<typeof HaulRun>;
