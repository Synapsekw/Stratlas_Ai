// Volumetric report, bug 1: a measurement's outline per survey date. A kit pile's toe line moves
// from survey to survey; each date's figure is worked out inside that date's own outline
// (`SurveyMeasurement.outlines`), and any date without one uses `points`.
import type {
  BoundaryEditsFile,
  MeasurementOutline,
  MeasurementsFile,
  SitePoint,
  StockPile,
  SurveyMeasurement,
  VolumesFile,
} from '@aio/schema';
import { NEIGHBOUR_M } from '../engine/compare';
import { ringArea, ringsWithin } from '../engine/geometry';
import { applyEdits, drapeZ, overlapShare, SAME_PILE_SHARE, type KitHeightAt } from './kitPiles';

/** The outline a measurement has on `capture`: that date's own, else `points`. */
export function outlineOn(
  m: Pick<SurveyMeasurement, 'points' | 'outlines'>,
  capture: string,
): readonly SitePoint[] {
  return m.outlines?.find((o) => o.capture === capture)?.points ?? m.points;
}

/**
 * The other piles next to `m` on `capture` (the engine's `CompareOptions.neighbours`): the outline
 * on that date of every other volume polygon in the same frame (both site-wide, or both of the same
 * survey) whose edge comes within `NEIGHBOUR_M` of `m`'s outline on that date. A pile with per-date
 * outlines but none on `capture` is not on that date; one without any is on every date. A polygon
 * sharing half the smaller outline or more with `m` (the same pile drawn again, or one holding it)
 * is never a neighbour: its edge is not a saddle between two heaps. In the order of `all`.
 */
export function pileNeighbours(
  m: {
    id: string;
    scope: SurveyMeasurement['scope'];
    points: readonly SitePoint[];
    outlines?: SurveyMeasurement['outlines'];
  },
  all: readonly SurveyMeasurement[],
  capture: string | undefined,
): [number, number][][] {
  const ownPts =
    (capture === undefined ? undefined : m.outlines?.find((o) => o.capture === capture)?.points) ??
    m.points;
  if (ownPts.length < 3) return [];
  const own: [number, number][] = ownPts.map((p) => [p[0], p[1]]);
  const frame = (x: { scope: SurveyMeasurement['scope'] }) =>
    x.scope.kind === 'survey' ? `survey:${x.scope.capture}` : x.scope.kind;
  const out: [number, number][][] = [];
  for (const x of all) {
    if (x.id === m.id || x.family !== 'polygon' || x.tool !== 'volume') continue;
    if (frame(x) !== frame(m)) continue;
    const pts =
      capture === undefined || !x.outlines?.length
        ? x.points
        : x.outlines.find((o) => o.capture === capture)?.points;
    if (!pts || pts.length < 3) continue;
    const ring: [number, number][] = pts.map((p) => [p[0], p[1]]);
    if (!ringsWithin(own, ring, NEIGHBOUR_M)) continue;
    if (overlapShare(own, ring) >= SAME_PILE_SHARE) continue;
    out.push(ring);
  }
  return out;
}

/** One series run: an outline and the captures worked out on it, in capture order. */
export interface SeriesRequest {
  ring: readonly SitePoint[];
  captures: string[];
}

const ringKey = (ring: readonly SitePoint[]): string =>
  ring.map((p) => `${p[0]},${p[1]}`).join(';');

/**
 * The series runs a measurement needs over `captures`: one per distinct outline (by its E, N
 * vertices), in the order its first capture comes, each with its captures in their given order.
 * A measurement without `outlines` gives one run over every capture on `points`.
 */
export function seriesRequests(
  m: Pick<SurveyMeasurement, 'points' | 'outlines'>,
  captures: readonly string[],
): SeriesRequest[] {
  const out: SeriesRequest[] = [];
  const byKey = new Map<string, SeriesRequest>();
  const keyOf = new Map<readonly SitePoint[], string>();
  for (const capture of captures) {
    const ring = outlineOn(m, capture);
    let key = keyOf.get(ring);
    if (key === undefined) {
      key = ringKey(ring);
      keyOf.set(ring, key);
    }
    const req = byKey.get(key);
    if (req) req.captures.push(capture);
    else {
      const next = { ring, captures: [capture] };
      byKey.set(key, next);
      out.push(next);
    }
  }
  return out;
}

/**
 * A kit pile's toe line on each date it has one (3 or more vertices), in survey order, placed in
 * the project CRS (`toSite`) and, with `heightAt`, draped on that date's DSM. Keyed by the
 * project capture id (`PileEpoch.captureId`), as a series result's `toCapture` is.
 */
export function kitOutlines(
  pile: Pick<StockPile, 'epochs'>,
  volumes: Pick<VolumesFile, 'captures'>,
  toSite: (xz: readonly [number, number]) => SitePoint,
  heightAt?: KitHeightAt,
): MeasurementOutline[] {
  const out: MeasurementOutline[] = [];
  const seen = new Set<string>();
  for (const c of volumes.captures) {
    const ep = pile.epochs[c.epoch];
    if (!ep || ep.ring.length < 3 || seen.has(ep.captureId)) continue;
    seen.add(ep.captureId);
    const flat = ep.ring.map((xz) => toSite(xz));
    const z = heightAt ? drapeZ(flat, (e, n) => heightAt(c.epoch, e, n)) : null;
    const points = z ? flat.map((p, i): SitePoint => [p[0], p[1], z[i] ?? p[2]]) : flat;
    out.push({ capture: ep.captureId, points });
  }
  return out;
}

/** How much of the larger of two outlines they have in common for a pile to count as unmoved. */
export const SAME_OUTLINE_SHARE = 0.98;
/** Vertices this close (metres) are the same vertex. */
const SAME_VERTEX_M = 1e-3;

type Ring2 = readonly (readonly [number, number])[];
const flat2 = (ring: readonly SitePoint[]): Ring2 => ring.map((p) => [p[0], p[1]] as const);

/** Whether two outlines are one: the same vertices, or in common over 98 % of the larger. */
function sameOutline(a: Ring2, b: Ring2): boolean {
  if (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i];
      return (
        !!q && Math.abs(p[0] - q[0]) <= SAME_VERTEX_M && Math.abs(p[1] - q[1]) <= SAME_VERTEX_M
      );
    })
  )
    return true;
  const areaA = ringArea(a);
  const areaB = ringArea(b);
  const larger = Math.max(areaA, areaB);
  if (!(larger > 0)) return false;
  return (overlapShare(a, b) * Math.min(areaA, areaB)) / larger >= SAME_OUTLINE_SHARE;
}

export interface KitOutlinesOptions {
  /** A kit local-frame point (`[x, z]`) to the project CRS (`kitToSite` through the origin). */
  toSite: (xz: readonly [number, number]) => SitePoint;
  /** The kit's DSM heights per date, to drape each outline on (`KitConversionOptions`). */
  heightAt?: KitHeightAt;
}

/**
 * The one-time fill for projects converted before per-date outlines: each kit-pile measurement
 * without `outlines`, not listed in `kitOutlinesAdded`, whose `points` are still the kit's latest
 * toe line (`SAME_OUTLINE_SHARE`), gets the kit's toe line per date (`kitOutlines`, hand edits
 * applied) and its id in `kitOutlinesAdded`. A pile the person moved or reshaped gets none.
 * Nothing else changes. The same file when nothing is filled.
 */
export function addKitOutlines(
  file: MeasurementsFile,
  volumes: VolumesFile,
  edits: BoundaryEditsFile | null,
  opts: KitOutlinesOptions,
): { file: MeasurementsFile; changed: string[] } {
  const done = new Set(file.kitOutlinesAdded ?? []);
  const piles = new Map<string, StockPile>();
  for (const p of applyEdits(volumes, edits?.edits ?? [])) if (!piles.has(p.id)) piles.set(p.id, p);
  const changed: string[] = [];
  const measurements = file.measurements.map((m) => {
    if (m.origin?.kind !== 'kit-pile' || m.outlines !== undefined || done.has(m.id)) return m;
    const pile = piles.get(m.origin.pile);
    if (!pile) return m;
    const outlines = kitOutlines(pile, volumes, opts.toSite, opts.heightAt);
    const latest = outlines.at(-1);
    if (!latest || !sameOutline(flat2(m.points), flat2(latest.points))) return m;
    changed.push(m.id);
    return { ...m, outlines };
  });
  if (changed.length === 0) return { file, changed };
  return {
    file: {
      ...file,
      measurements,
      kitOutlinesAdded: [...(file.kitOutlinesAdded ?? []), ...changed],
    },
    changed,
  };
}
