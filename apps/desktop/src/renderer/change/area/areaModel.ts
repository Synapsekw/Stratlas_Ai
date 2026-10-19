import { toWgs84 } from '@aio/geo';
import type { ChangeScope, LonLatRing, SurveyMeasurement } from '@aio/schema';
import { t } from '@aio/ui';
import { stepCapture, type CaptureIndex } from '@aio/workspace';

/** Pure model for comparing one polygon measurement with the previous survey. */

type XY = readonly [number, number];

const ORIGIN: XY = [0, 0];
const at = (pts: readonly XY[], i: number): XY => pts[i] ?? ORIGIN;

/** Points with repeats (including a repeated closing point) taken out, by E and N. */
function distinct(points: readonly (readonly number[])[]): XY[] {
  const out: XY[] = [];
  for (const p of points) {
    const [e = 0, n = 0] = p;
    if (!out.some((q) => q[0] === e && q[1] === n)) out.push([e, n]);
  }
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

/**
 * The polygon as an open lon/lat ring, or why it cannot be compared. A bow-tie has zero signed
 * area, so crossing is checked before the area to report it as a crossing.
 */
export function polygonRing(
  m: SurveyMeasurement,
  epsg: number | null,
): { ring: LonLatRing } | { reason: string } {
  if (m.family !== 'polygon') return { reason: t('actions.area.reason.notPolygon') };
  if (epsg === null) return { reason: t('actions.area.reason.noMap') };
  const pts = distinct(m.points);
  if (pts.length < 3) return { reason: t('actions.area.reason.tooFew') };
  if (selfIntersects(pts)) return { reason: t('actions.area.reason.crossing') };
  if (shoelace(pts) < 1e-6) return { reason: t('actions.area.reason.zeroArea') };
  const ring = pts.map(([e, n]) => {
    const [lon, lat] = toWgs84([e, n, 0], epsg);
    return [lon, lat] as [number, number];
  });
  return { ring };
}

/** The survey before the one the polygon belongs to (dates off: the latest survey and its predecessor). */
export function previousPair(
  index: CaptureIndex,
  m: SurveyMeasurement,
  focus: string | null,
): { from: string; to: string } | { reason: string } {
  const known = (id: string | null | undefined): id is string =>
    !!id && index.captures.some((c) => c.id === id);
  const current = m.scope.kind === 'survey' ? m.scope.capture : focus;
  const to = known(current) ? current : (index.captures.at(-1)?.id ?? null);
  const from = to ? stepCapture(index, to, -1) : null;
  if (!to || !from) return { reason: t('actions.area.reason.noEarlier') };
  return { from, to };
}

/** The scope a run is filed under: the measurement id and its label, cut to 120 characters. */
export function areaScope(m: SurveyMeasurement): ChangeScope {
  return { id: m.id, name: m.label.trim().slice(0, 120) };
}
