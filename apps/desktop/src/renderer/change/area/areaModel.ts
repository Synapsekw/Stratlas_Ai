import { isKnownCrs, toWgs84 } from '@aio/geo';
import {
  shiftKey,
  type ChangeScope,
  type LonLatRing,
  type ProjectManifest,
  type SurveyMeasurement,
} from '@aio/schema';
import { t } from '@aio/ui';
import { stepCapture, type CaptureIndex } from '@aio/workspace';
import { drawnPoints, scopeShift } from '../../survey/measureDates';

/** Pure model for comparing one polygon measurement with the previous survey. */

/** What placing a polygon needs of the project: its CRS and the dates' line-ups. */
export type AreaManifest = Pick<ProjectManifest, 'crs' | 'origin' | 'captures' | 'layers'>;

type XY = readonly [number, number];

const ORIGIN: XY = [0, 0];
const at = (pts: readonly XY[], i: number): XY => pts[i] ?? ORIGIN;

/**
 * Points with consecutive repeats (and a repeated closing point) taken out, by E and N. A vertex
 * the outline comes back to later stays: taking it out would change the shape.
 */
function distinct(points: readonly (readonly number[])[]): XY[] {
  const out: XY[] = [];
  for (const p of points) {
    const [e = 0, n = 0] = p;
    const last = out.at(-1);
    if (last?.[0] !== e || last[1] !== n) out.push([e, n]);
  }
  const first = out[0];
  const last = out.at(-1);
  if (out.length > 1 && first?.[0] === last?.[0] && first?.[1] === last?.[1]) out.pop();
  return out;
}

function shoelace(pts: readonly XY[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = at(pts, i);
    const b = at(pts, (i + 1) % pts.length);
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

function cross(o: XY, a: XY, b: XY): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function onSegment(a: XY, b: XY, p: XY): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return (
    (d1 === 0 && onSegment(a, b, c)) ||
    (d2 === 0 && onSegment(a, b, d)) ||
    (d3 === 0 && onSegment(c, d, a)) ||
    (d4 === 0 && onSegment(c, d, b))
  );
}

/** True when two non-adjacent edges of the closed ring meet. */
function selfIntersects(pts: readonly XY[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsIntersect(at(pts, i), at(pts, (i + 1) % n), at(pts, j), at(pts, (j + 1) % n)))
        return true;
    }
  }
  return false;
}

type RingResult = { ring: LonLatRing } | { reason: string };

/** The shape checks of a measurement's points (self-crossing is O(n²)), kept per points array. */
type ShapeProblem = 'tooFew' | 'crossing' | 'zeroArea';
const shapes = new WeakMap<object, ShapeProblem | null>();

/** Why the stored outline is no usable polygon (the first reason wins), or null. */
function shapeProblem(m: SurveyMeasurement): ShapeProblem | null {
  const known = shapes.get(m.points);
  if (known !== undefined) return known;
  // a date's line-up moves, turns and scales the outline as a whole: its shape stays the same
  const pts = distinct(m.points);
  const why: ShapeProblem | null =
    pts.length < 3
      ? 'tooFew'
      : selfIntersects(pts)
        ? 'crossing'
        : shoelace(pts) < 1e-6
          ? 'zeroArea'
          : null;
  shapes.set(m.points, why);
  return why;
}

/** The last ring built per points array, for its CRS and line-up (the menu asks on every open). */
const rings = new WeakMap<object, { key: string; ring: LonLatRing }>();

/**
 * The polygon as an open lon/lat ring, or why it cannot be compared. The ring is where the
 * polygon is drawn: a survey polygon takes its date's line-up (shift, turn and scale), as the
 * pipelines place that date's ortho and surface. A bow-tie has zero signed area, so crossing is
 * checked before the area to report it as a crossing.
 */
export function polygonRing(m: SurveyMeasurement, manifest: AreaManifest): RingResult {
  if (m.family !== 'polygon') return { reason: t('actions.area.reason.notPolygon') };
  const epsg = 'epsg' in manifest.crs ? manifest.crs.epsg : null;
  if (epsg === null) return { reason: t('actions.area.reason.noMap') };
  if (!isKnownCrs(epsg)) return { reason: t('actions.area.reason.unknownCrs', { epsg }) };
  const problem = shapeProblem(m);
  if (problem) return { reason: t(`actions.area.reason.${problem}`) };
  const key = `${String(epsg)}|${shiftKey(scopeShift(m.scope, manifest))}`;
  const cached = rings.get(m.points);
  if (cached?.key === key) return { ring: cached.ring };
  try {
    const ring = distinct(drawnPoints(m, manifest)).map(([e, n]) => {
      const [lon, lat] = toWgs84([e, n, 0], epsg);
      return [lon, lat] as [number, number];
    });
    rings.set(m.points, { key, ring });
    return { ring };
  } catch {
    return { reason: t('actions.area.reason.unknownCrs', { epsg }) };
  }
}

/**
 * The survey before the one the polygon belongs to. A site polygon takes the focused survey, or
 * the latest survey and its predecessor when dates are off or the first survey is focused.
 */
export function previousPair(
  index: CaptureIndex,
  m: SurveyMeasurement,
  focus: string | null,
): { from: string; to: string } | { reason: string } {
  const known = (id: string | null | undefined): id is string =>
    !!id && index.captures.some((c) => c.id === id);
  if (m.scope.kind === 'survey' && !known(m.scope.capture)) {
    return { reason: t('actions.area.reason.noEarlier') };
  }
  const latest = index.captures.at(-1)?.id ?? null;
  const current = m.scope.kind === 'survey' ? m.scope.capture : focus;
  let to = known(current) ? current : latest;
  let from = to ? stepCapture(index, to, -1) : null;
  if (!from && m.scope.kind === 'site' && latest && to !== latest) {
    to = latest;
    from = stepCapture(index, latest, -1);
  }
  if (!to || !from) return { reason: t('actions.area.reason.noEarlier') };
  return { from, to };
}

const NAME_MAX = 120;

/**
 * The scope a run is filed under: the measurement id and its label, cut to 120 characters. The
 * cut is between characters (never inside a surrogate pair) and stays within 120 UTF-16 units.
 */
export function areaScope(m: SurveyMeasurement): ChangeScope {
  let name = '';
  for (const ch of m.label.trim()) {
    if (name.length + ch.length > NAME_MAX) break;
    name += ch;
  }
  return { id: m.id, name: name || m.id };
}
