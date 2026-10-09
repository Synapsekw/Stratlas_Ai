/**
 * Haul-road compliance (M11 G11, PRD HRD-1) without React: the site's default limits (the loose
 * `haul` key of `survey/settings.json`), the minimum berm height from the largest truck's wheel,
 * building checked `haul.analyse` parameters from the panel's text fields, a run's staleness, and
 * the labels and numbers of the results table. The measuring is the pipeline's
 * (`python/src/aio_pipelines/haul/`); runs are `aio.haul-run/1` (`HaulRun`).
 */
import {
  pipelineParams,
  type HaulAnalyseParams,
  type HaulCheck,
  type HaulCheckStatus,
  type HaulRun,
  type HaulStation,
  type HeightTiles,
} from '@aio/schema';

export type HaulLimits = HaulAnalyseParams['limits'];
export type HaulLimitKey = keyof HaulLimits;

/** The site defaults kept in `survey/settings.json` under `haul` (a loose key). */
export interface HaulSiteDefaults {
  intervalM: number;
  limits: HaulLimits;
  /** The largest truck's wheel height, metres, and the share of it a berm must reach. */
  wheelHeightM?: number;
  wheelShare: number;
}

/** Common haul-road practice; every value is the site's to change. */
export const HAUL_DEFAULTS: HaulSiteDefaults = {
  intervalM: 10,
  limits: {
    minWidthM: 20,
    maxGradePct: 10,
    crossFallMinPct: 1,
    crossFallMaxPct: 4,
    minBermHeightM: 1,
  },
  wheelShare: 0.5,
};

export const LIMIT_FIELDS: { key: HaulLimitKey; label: string }[] = [
  { key: 'minWidthM', label: 'Minimum width (m)' },
  { key: 'maxGradePct', label: 'Maximum grade (%)' },
  { key: 'crossFallMinPct', label: 'Cross fall from (%)' },
  { key: 'crossFallMaxPct', label: 'Cross fall to (%)' },
  { key: 'minBermHeightM', label: 'Minimum berm height (m)' },
];

export const CHECK_LABELS: Record<HaulCheck, string> = {
  width: 'Width',
  grade: 'Grade',
  crossFall: 'Cross fall',
  superelevation: 'Superelevation',
  bermLeft: 'Left berm',
  bermRight: 'Right berm',
};

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** The site's defaults from the settings file's loose `haul` key, over the built-in ones. */
export function haulDefaults(settings: unknown): HaulSiteDefaults {
  const raw =
    settings && typeof settings === 'object' ? (settings as { haul?: unknown }).haul : undefined;
  if (!raw || typeof raw !== 'object') return HAUL_DEFAULTS;
  const h = raw as Record<string, unknown>;
  const limits: HaulLimits = {};
  const given =
    h.limits && typeof h.limits === 'object' ? (h.limits as Record<string, unknown>) : {};
  for (const { key } of LIMIT_FIELDS) {
    const v = num(given[key]);
    if (v !== undefined) limits[key] = v;
  }
  const interval = num(h.intervalM);
  const wheel = num(h.wheelHeightM);
  const share = num(h.wheelShare);
  return {
    intervalM: interval !== undefined && interval > 0 ? interval : HAUL_DEFAULTS.intervalM,
    limits: Object.keys(limits).length ? limits : HAUL_DEFAULTS.limits,
    ...(wheel !== undefined && wheel > 0 ? { wheelHeightM: wheel } : {}),
    wheelShare: share !== undefined && share > 0 && share <= 2 ? share : HAUL_DEFAULTS.wheelShare,
  };
}

/** The minimum berm height for the largest truck: `share` of its wheel height (metres). */
export function minBermHeight(wheelHeightM: number, share = HAUL_DEFAULTS.wheelShare): number {
  if (!(wheelHeightM > 0) || !(share > 0 && share <= 2))
    throw new Error('The wheel height must be positive and the share between 0 and 2.');
  return Math.round(wheelHeightM * share * 1000) / 1000;
}

/** The centreline the panel picked: drawn points, or a design layer. */
export type CentrelinePick =
  | { kind: 'drawn'; points: readonly (readonly [number, number, ...number[]])[] }
  | { kind: 'design'; design: string; layer: string };

/** Text fields to checked `haul.analyse` parameters, or the sentence saying what is wrong. */
export function buildHaulParams(input: {
  surface: string;
  centreline: CentrelinePick | null;
  intervalM: string;
  limits: Partial<Record<HaulLimitKey, string>>;
  run?: string;
}): { ok: true; params: HaulAnalyseParams } | { ok: false; error: string } {
  if (!input.surface) return { ok: false, error: 'Pick a prepared surface.' };
  if (!input.centreline) return { ok: false, error: 'Pick a centreline.' };
  const interval = Number(input.intervalM);
  if (!input.intervalM.trim() || !Number.isFinite(interval) || interval <= 0)
    return { ok: false, error: 'The section interval must be a number of metres above 0.' };
  const limits: HaulLimits = {};
  for (const { key, label } of LIMIT_FIELDS) {
    const t = (input.limits[key] ?? '').trim();
    if (!t) continue;
    const v = Number(t);
    if (!Number.isFinite(v)) return { ok: false, error: `${label} must be a number.` };
    limits[key] = v;
  }
  if (
    limits.crossFallMinPct !== undefined &&
    limits.crossFallMaxPct !== undefined &&
    limits.crossFallMinPct > limits.crossFallMaxPct
  )
    return { ok: false, error: 'The cross fall range starts above where it ends.' };
  const c = input.centreline;
  const centreline =
    c.kind === 'design'
      ? { design: c.design, layer: c.layer }
      : c.points.map((p): [number, number] => [p[0], p[1]]);
  if (Array.isArray(centreline) && centreline.length < 2)
    return { ok: false, error: 'The centreline needs at least two points.' };
  const r = pipelineParams('haul.analyse').safeParse({
    surface: input.surface,
    centreline,
    intervalM: interval,
    limits,
    ...(input.run ? { run: input.run } : {}),
  });
  if (!r.success) {
    const first = r.error.issues[0];
    const key = first?.path.at(-1);
    const field = LIMIT_FIELDS.find((f) => f.key === key);
    return {
      ok: false,
      error: `${field?.label ?? String(key ?? 'A value')}: ${first?.message ?? 'not valid'}`,
    };
  }
  return { ok: true, params: r.data as HaulAnalyseParams };
}

/** A fresh run id: `haul-<UTC date and time>` (a `SurveyId`). */
export function newRunId(now: Date = new Date()): string {
  return `haul-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}`;
}

/** Why a run is stale (its surface changed or is gone), or null when it is current. */
export function staleReason(run: HaulRun, surfaces: readonly HeightTiles[] | null): string | null {
  if (!surfaces) return null;
  const s = surfaces.find((x) => x.id === run.surface.id);
  if (!s) return `The surface ${run.surface.name} is no longer prepared.`;
  return s.fingerprint === run.surface.fingerprint
    ? null
    : `The surface ${run.surface.name} changed since this run.`;
}

const fixed = (v: number | null | undefined, d: number): string =>
  v === null || v === undefined ? '-' : v.toFixed(d);

/** The table's numbers for a station (SI, as stored; units at the edges are G1's). */
export function stationCells(st: HaulStation): Record<string, string> {
  const berm = (b: HaulStation['bermLeft']): string =>
    !b
      ? '-'
      : b.kind === 'drop'
        ? 'none'
        : b.kind === 'bank'
          ? `bank ${fixed(b.heightM, 2)}`
          : fixed(b.heightM, 2);
  return {
    width: fixed(st.widthM, 2),
    grade: fixed(st.gradePct, 1),
    crossFall: st.turn
      ? `super ${fixed(st.superelevationPct, 1)}`
      : `${fixed(st.crossFallLeftPct, 1)} / ${fixed(st.crossFallRightPct, 1)}`,
    bermLeft: berm(st.bermLeft),
    bermRight: berm(st.bermRight),
  };
}

/** The checks a station failed, as words. */
export function failedChecks(st: HaulStation): string[] {
  return (Object.entries(st.checks) as [HaulCheck, HaulCheckStatus][])
    .filter(([, v]) => v === 'fail')
    .map(([k]) => CHECK_LABELS[k]);
}

export const STATUS_COLOR: Record<HaulStation['status'], string> = {
  pass: '#2fbf71',
  fail: '#e5484d',
  'no-data': '#9aa0a6',
};

/** One coloured piece of the centreline (project CRS, E, N, Z). */
export interface HaulPiece {
  station: string;
  status: HaulStation['status'];
  color: string;
  points: [number, number, number][];
}

/**
 * The centreline pieces of a run's GeoJSON (`haul.geojson`), each with its status colour; Z falls
 * back to the station's height where the surface had none.
 */
export function piecesOf(geojson: unknown, run: HaulRun): HaulPiece[] {
  const feats =
    geojson && typeof geojson === 'object' ? (geojson as { features?: unknown }).features : null;
  if (!Array.isArray(feats)) return [];
  const zOf = new Map(run.stations.map((s) => [s.stationLabel, s.z ?? 0]));
  const out: HaulPiece[] = [];
  for (const f of feats as { properties?: Record<string, unknown>; geometry?: unknown }[]) {
    const p = f.properties ?? {};
    const g = f.geometry as { type?: string; coordinates?: unknown } | undefined;
    if (p.kind !== 'centreline' || g?.type !== 'LineString' || !Array.isArray(g.coordinates))
      continue;
    const station = typeof p.station === 'string' ? p.station : '';
    const status = p.status === 'fail' || p.status === 'no-data' ? p.status : 'pass';
    const z0 = zOf.get(station) ?? 0;
    const points = (g.coordinates as unknown[]).flatMap((c): [number, number, number][] =>
      Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number'
        ? [[c[0], c[1], typeof c[2] === 'number' ? c[2] : z0]]
        : [],
    );
    if (points.length >= 2) out.push({ station, status, color: STATUS_COLOR[status], points });
  }
  return out;
}
