/**
 * Heights from the prepared surfaces of every survey date, for the measurement card (volumetric
 * parity W2): a point's elevation over time (elevation history folded into the point card), a
 * line's profile and a polygon's terrain area per date. Heights are read from the prepared height
 * tiles with the survey engine's own sampler (`@aio/survey` `bilinear`), so they match the
 * comparisons; a date with no data at a place is null, never 0.
 */
import type { HeightTiles } from '@aio/schema';
import { bilinear, TileSurface, type HeightSampler } from '@aio/survey';
import type { SurfaceState } from '../surfaceStates';
import { presample, type SampleMany } from './terrain';

export type FetchTile = (col: number, row: number) => Promise<Uint8Array | null>;

/** Bytes of a project file through the app's protocol, or null when it is missing. */
async function fetchBytes(projectId: string, path: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(`aio://project/${encodeURIComponent(projectId)}/${path}`);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** The tile reader of one prepared surface of a project (its full-resolution level). */
export function surfaceTiles(projectId: string, s: Pick<HeightTiles, 'id'>): FetchTile {
  return (col, row) =>
    fetchBytes(projectId, `survey/surfaces/${s.id}/0/${String(col)}_${String(row)}.bin`);
}

/** The height of one prepared surface at (E, N); null where it has no data. */
export async function heightAt(
  s: HeightTiles,
  e: number,
  n: number,
  fetchTile: FetchTile,
): Promise<number | null> {
  const g = new TileSurface(s.id, s, fetchTile);
  const z = (
    await bilinear(g, new Float64Array([e - s.originE]), new Float64Array([n - s.originN]), 0, 0)
  )[0];
  return z !== undefined && Number.isFinite(z) ? z : null;
}

/**
 * Run a synchronous computation over a sampler (`lineMetrics`, `sampleProfile`, `polygonAreas`)
 * against a prepared surface: a first pass records where it samples, the tiles are read once for
 * all of those places with the engine's sampler, and a second pass runs on the heights read. The
 * computation must sample the same places whatever heights it gets, as those functions do.
 */
export async function withSurface<T>(
  compute: (h: HeightSampler) => T,
  s: HeightTiles,
  fetchTile: FetchTile,
): Promise<T> {
  return compute(await presample(compute, tilesSampler(s, fetchTile)));
}

/**
 * Many places of one prepared surface at once, with the engine's sampler (NaN: no data). An abort
 * (the card closed) stops reading tiles.
 */
export function tilesSampler(
  s: HeightTiles,
  fetchTile: FetchTile,
  signal?: AbortSignal,
): SampleMany {
  const g = new TileSurface(s.id, s, fetchTile);
  return (es, ns) =>
    bilinear(
      g,
      es.map((e) => e - s.originE),
      ns.map((n) => n - s.originN),
      0,
      0,
      signal,
    );
}

/** A survey date, its surface state and its prepared surface (null until it is ready). */
export interface DatedSurface {
  capture: string;
  label: string;
  date: string;
  state: SurfaceState;
  tiles: HeightTiles | null;
}

/** The reason in place of "No survey data" (spec section 2), by the i18n key that says it. */
export type EmptyReason =
  'mcard.surfacePreparing' | 'mcard.notPrepared' | 'mcard.noElevation' | 'mcard.notMeasured';

/**
 * Why there is no height to show for these dates: a surface preparing (or missing while `soon`: a
 * prepare job runs or the background preparation will start one), a surface not prepared yet (no
 * job will come on its own: auto-prepare off, a package, no pipeline Python, a cancelled or failed
 * job), no elevation at all, else nothing measured there on the dates that have one.
 */
export function emptyReason(states: readonly SurfaceState[], soon = false): EmptyReason {
  if (states.some((s) => s.kind === 'preparing')) return 'mcard.surfacePreparing';
  if (states.some((s) => s.kind === 'missing'))
    return soon ? 'mcard.surfacePreparing' : 'mcard.notPrepared';
  if (states.every((s) => s.kind === 'none')) return 'mcard.noElevation';
  return 'mcard.notMeasured';
}

/** One row of a point's elevation over time (the `TimeChart` elevation rows). */
export interface PointHistoryRow {
  capture: string;
  label: string;
  date: string;
  z: number | null;
}

/** A point's height on every date, oldest first; null where a date has no data or no surface yet. */
export async function pointHistory(
  dated: readonly DatedSurface[],
  e: number,
  n: number,
  fetchFor: (s: HeightTiles) => FetchTile,
): Promise<PointHistoryRow[]> {
  const sorted = [...dated].sort((a, b) => a.date.localeCompare(b.date));
  return Promise.all(
    sorted.map(async (d) => ({
      capture: d.capture,
      label: d.label,
      date: d.date,
      z: d.tiles ? await heightAt(d.tiles, e, n, fetchFor(d.tiles)) : null,
    })),
  );
}
