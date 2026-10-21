// A survey date's prepared surfaces as a height sampler (the surface the date's own measurements
// are read on), and the ground heights under drawn points. Uses the prepared surfaces the compare
// store holds; a date without one has no sampler.
import {
  shiftEN,
  type DateShift,
  type HeightTiles,
  type MeasurementScope,
  type ProjectManifest,
  type SitePoint,
} from '@aio/schema';
import {
  projectResolver,
  samplerOf,
  surfaceOfCapture,
  TileCache,
  type PointSampler,
} from '@aio/survey';
import { captureShift } from '@aio/workspace';
import { compareStore } from './compareStore';
import { fetchBytes } from './sectionEngine';

/** True when the date has a prepared surface of its own. */
export function hasPrepared(surfaces: readonly HeightTiles[], capture: string): boolean {
  return surfaceOfCapture(surfaces, capture) !== null;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

const cache = new TileCache();
// per surfaces array, then per project and date
const memo = new WeakMap<readonly HeightTiles[], Map<string, Promise<PointSampler | null>>>();
let override: ((capture: string) => Promise<PointSampler | null>) | null = null;

/** Tests: answer samplers from here instead of the prepared surfaces (null: back to normal). */
export function setDateSurfaceSource(
  fn: ((capture: string) => Promise<PointSampler | null>) | null,
): void {
  override = fn;
}

/** The sampler over the date's prepared surface, or null when the date has none. */
export function dateSampler(capture: string): Promise<PointSampler | null> {
  if (override) return override(capture);
  const { projectId, surfaces, designs, captures } = compareStore.getState();
  if (!projectId || !hasPrepared(surfaces, capture)) return Promise.resolve(null);
  let byKey = memo.get(surfaces);
  if (!byKey) {
    byKey = new Map();
    memo.set(surfaces, byKey);
  }
  const key = `${projectId}\u0000${capture}`;
  let run = byKey.get(key);
  if (!run) {
    const base = `aio://project/${encodeURIComponent(projectId)}/`;
    const resolve = projectResolver({
      surfaces,
      designs,
      captures: captures.map((c) => c.id),
      capture,
      cache,
      fetchBytes: (path) => fetchBytes(`${base}${encodePath(path)}`),
    });
    run = resolve({ kind: 'current' })
      .then((r) => samplerOf(r).sample)
      .catch(() => null);
    byKey.set(key, run);
  }
  return run;
}

/** The line-up a prepared surface's cells sit at: its `dateShiftM` with its `dateTurn`. */
function preparedShift(s: HeightTiles | null, origin: readonly number[]): DateShift | null {
  if (!s || (!s.dateShiftM && !s.dateTurn)) return null;
  const out: DateShift = { eastM: s.dateShiftM?.eastM ?? 0, northM: s.dateShiftM?.northM ?? 0 };
  const turn = s.dateTurn;
  if (turn)
    out.turn = {
      ...turn,
      pivotX: turn.pivotE - (origin[0] ?? 0),
      pivotZ: (origin[1] ?? 0) - turn.pivotN,
    };
  return out;
}

type Dated = Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>;

/**
 * The line-up the date's prepared surface sits at: the frame of a ring found on that surface (a
 * whole-site region). A date without a prepared surface: its line-up now (as `ringShifts`).
 */
export function preparedShiftOf(capture: string, manifest: Dated): DateShift | null {
  const s = surfaceOfCapture(compareStore.getState().surfaces, capture);
  return s ? preparedShift(s, manifest.origin) : captureShift(manifest, capture);
}

/**
 * Points found on a date's prepared surface (a whole-site region's ring) to what is saved for a
 * scope: the prepared line-up subtracted, so the engine (which adds it back) reads the same spot.
 * A site-wide scope keeps them as they are.
 */
export function storedFromPrepared(
  points: readonly SitePoint[],
  scope: MeasurementScope,
  manifest: Dated | null,
): SitePoint[] {
  const s = scope.kind === 'survey' && manifest ? preparedShiftOf(scope.capture, manifest) : null;
  return s ? points.map((p) => shiftEN(p, s, -1)) : [...points];
}

/**
 * The date's prepared surface as a sampler of drawn points, null when the date has none. A drawn
 * point sits where the date is lined up now; the surface sits where it was prepared, so the point
 * is moved back by the date's line-up (its turn too) and on by the line-up the surface was
 * prepared with (as `ringShifts` does for a ring). Without a manifest the points go as they are.
 */
export async function drawnSampler(
  capture: string,
  manifest: Dated | null,
): Promise<PointSampler | null> {
  const sample = await dateSampler(capture);
  if (!sample || !manifest) return sample;
  const now = captureShift(manifest, capture);
  const s = surfaceOfCapture(compareStore.getState().surfaces, capture);
  const prepared = preparedShift(s, manifest.origin);
  return (es, ns, signal) => {
    const e = new Float64Array(es.length);
    const n = new Float64Array(es.length);
    for (let i = 0; i < es.length; i++) {
      const p = shiftEN(shiftEN([es[i] ?? 0, ns[i] ?? 0], now, -1), prepared);
      e[i] = p[0] ?? 0;
      n[i] = p[1] ?? 0;
    }
    return sample(e, n, signal);
  };
}

/**
 * The ground height under each drawn point on the date's prepared surface (`drawnSampler`), NaN
 * where there is none.
 */
export async function groundAt(
  capture: string,
  drawn: readonly SitePoint[],
  manifest: Dated,
): Promise<Float64Array> {
  const none = () => new Float64Array(drawn.length).fill(Number.NaN);
  const sample = await drawnSampler(capture, manifest);
  if (!sample || drawn.length === 0) return none();
  try {
    return await sample(
      Float64Array.from(drawn, (p) => p[0]),
      Float64Array.from(drawn, (p) => p[1]),
    );
  } catch {
    return none();
  }
}
