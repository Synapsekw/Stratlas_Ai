/**
 * The line geometry behind the linked hover (spec section 4): where a chainage is on a line, which
 * chainage a site point or a screen pointer is at, and the marker a chart hover shows in the scene.
 * Pure; no NaN leaves these functions.
 */
import type { ChartSeries } from '@aio/survey';
import type { HoverLine } from './linkedHover';

type Pt = readonly [number, number];

/** Where along the line (E, N) a chainage is, clamped to the ends. */
export function pointAt(polyline: readonly Pt[], chainageM: number): [number, number] {
  const first = polyline[0];
  if (!first) return [0, 0];
  if (!Number.isFinite(chainageM) || chainageM <= 0) return [first[0], first[1]];
  let base = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (chainageM <= base + len || i === polyline.length - 1) {
      const f = len > 0 ? Math.min(1, Math.max(0, (chainageM - base) / len)) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    base += len;
  }
  return [first[0], first[1]];
}

/** The nearest point on a polyline to (x, y): its distance along the line and how far off it is. */
function nearest(
  pts: readonly Pt[],
  along: (i: number, segLen: number) => [number, number],
  x: number,
  y: number,
): { along: number; dist: number } | null {
  let best: { along: number; dist: number } | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
    const dist = Math.hypot(a[0] + dx * f - x, a[1] + dy * f - y);
    if (!best || dist < best.dist) {
      const [start, end] = along(i, Math.sqrt(len2));
      best = { along: start + (end - start) * f, dist };
    }
  }
  return best;
}

/** The chainage of the nearest point on the line to a site point, and its distance from the line. */
export function chainageOf(
  polyline: readonly Pt[],
  e: number,
  n: number,
): { chainageM: number; offsetM: number } {
  const cumul = [0];
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    cumul.push((cumul[i - 1] ?? 0) + (a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0));
  }
  const hit = nearest(polyline, (i) => [cumul[i - 1] ?? 0, cumul[i] ?? 0], e, n);
  if (!hit || !Number.isFinite(hit.along)) {
    const p = polyline[0];
    return { chainageM: 0, offsetM: p ? Math.hypot(e - p[0], n - p[1]) : 0 };
  }
  return { chainageM: hit.along, offsetM: hit.dist };
}

/**
 * The chainage of the nearest point on the projected line to a screen pointer, or null when the
 * pointer is more than `maxPx` away. `cumulM` holds each projected vertex's chainage.
 */
export function snapScreen(
  screen: readonly Pt[],
  cumulM: readonly number[],
  x: number,
  y: number,
  maxPx = 12,
): number | null {
  const hit = nearest(screen, (i) => [cumulM[i - 1] ?? 0, cumulM[i] ?? 0], x, y);
  if (!hit || hit.dist > maxPx || !Number.isFinite(hit.along)) return null;
  return hit.along;
}

/** A series' z at a chainage, linearly interpolated; null outside its samples or in a gap. */
function zAt(s: ChartSeries, c: number): number | null {
  const { chainage, z } = s;
  for (let i = 0; i < chainage.length; i++) {
    const ci = chainage[i];
    if (ci === undefined) continue;
    if (ci === c) {
      const zi = z[i];
      return zi !== null && zi !== undefined && Number.isFinite(zi) ? zi : null;
    }
    if (ci > c) {
      if (i === 0) return null;
      const c0 = chainage[i - 1];
      const z0 = z[i - 1];
      const z1 = z[i];
      if (c0 === undefined || z0 === null || z0 === undefined || z1 === null || z1 === undefined)
        return null;
      const v = ci > c0 ? z0 + ((z1 - z0) * (c - c0)) / (ci - c0) : z0;
      return Number.isFinite(v) ? v : null;
    }
  }
  return null;
}

export interface HoverMarker {
  e: number;
  n: number;
  /** One per shown series with a surface there, in the line's series order (oldest first). */
  dots: { key: string; capture?: string; z: number }[];
  /** Newest dated dot minus the dated dot before it, in m; null with fewer than two. */
  deltaM: number | null;
}

/** The marker the scene shows for a chainage on a line. */
export function markerAt(line: HoverLine, chainageM: number): HoverMarker {
  const c = Number.isFinite(chainageM) ? chainageM : 0;
  const [e, n] = pointAt(line.polyline, c);
  const dots: HoverMarker['dots'] = [];
  const dated: { date: string; z: number }[] = [];
  for (const s of line.series) {
    const z = zAt(s, c);
    if (z === null) continue;
    dots.push(s.capture !== undefined ? { key: s.key, capture: s.capture, z } : { key: s.key, z });
    if (s.date) dated.push({ date: s.date, z });
  }
  // stable sort: same-date series keep the line's order
  dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const newest = dated[dated.length - 1];
  const before = dated[dated.length - 2];
  return { e, n, dots, deltaM: newest && before ? newest.z - before.z : null };
}

export interface TagFormat {
  /** A chainage with its unit, "42.3 m". */
  chainage(m: number): string;
  /** A height difference's magnitude without sign or unit, "1.63". */
  magnitude(m: number): string;
}

/** The scene tag: "42.3 m · −1.63" (Unicode minus for cut, plus for fill), no delta part when null. */
export function tagText(chainageM: number, deltaM: number | null, fmt: TagFormat): string {
  const head = fmt.chainage(chainageM);
  if (deltaM === null || !Number.isFinite(deltaM)) return head;
  const mag = fmt.magnitude(Math.abs(deltaM));
  const sign = /[1-9]/.test(mag) ? (deltaM < 0 ? '−' : '+') : '';
  return `${head} · ${sign}${mag}`;
}
