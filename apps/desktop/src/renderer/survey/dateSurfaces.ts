// A survey date's prepared surfaces as a height sampler (the surface the date's own measurements
// are read on), and the ground heights under drawn points. Uses the prepared surfaces the compare
// store holds; a date without one has no sampler.
import type { HeightTiles, ProjectManifest, SitePoint } from '@aio/schema';
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

/**
 * The ground height under each drawn point on the date's prepared surface, NaN where there is
 * none. A drawn point sits where the date is lined up now; the surface sits where it was prepared,
 * so the point is moved back by the date's line-up and on by the shift the surface was prepared
 * with (as `ringShifts` does for a ring).
 */
export async function groundAt(
  capture: string,
  drawn: readonly SitePoint[],
  manifest: Pick<ProjectManifest, 'captures' | 'layers' | 'origin'>,
): Promise<Float64Array> {
  const none = () => new Float64Array(drawn.length).fill(Number.NaN);
  const sample = await dateSampler(capture);
  if (!sample || drawn.length === 0) return none();
  const now = captureShift(manifest, capture);
  const s = surfaceOfCapture(compareStore.getState().surfaces, capture);
  const dE = (s?.dateShiftM?.eastM ?? 0) - (now?.eastM ?? 0);
  const dN = (s?.dateShiftM?.northM ?? 0) - (now?.northM ?? 0);
  try {
    return await sample(
      Float64Array.from(drawn, (p) => p[0] + dE),
      Float64Array.from(drawn, (p) => p[1] + dN),
    );
  } catch {
    return none();
  }
}
