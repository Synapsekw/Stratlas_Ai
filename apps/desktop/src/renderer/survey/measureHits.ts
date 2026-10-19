/**
 * Which measurement is under the cursor in a view (pick and right-click menu): the shapes the view
 * draws, put on screen by the view's own projection. Pure: no store, no DOM.
 */
import type { SitePoint } from '@aio/schema';
import type { ScreenPt, ToScreen } from '@aio/survey';

/** How near an edge or a vertex the cursor must be, in CSS px. */
export const HIT_PX = 6;

/** A drawn measurement as the hit test sees it (its drawn points, line-up shift included). */
export interface HitShape {
  id: string;
  points: readonly SitePoint[];
  closed: boolean;
}

/** Distance from `p` to the segment `a`..`b` (to `a` when the segment has no length). */
export function distanceToSegment(p: ScreenPt, a: ScreenPt, b: ScreenPt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether `p` lies inside the ring (even-odd ray cast). */
export function insideRing(p: ScreenPt, ring: readonly ScreenPt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/** The ring's area on screen (shoelace). */
function ringArea(ring: readonly ScreenPt[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a && b) sum += (b.x + a.x) * (b.y - a.y);
  }
  return Math.abs(sum) / 2;
}

/**
 * The measurement under client point (x, y): the nearest edge or vertex within `tol` (a later
 * shape wins a tie: it is drawn on top), else the smallest closed shape whose ring holds the
 * cursor, else null. Points behind the camera (`toScreen` null) take no part.
 */
export function measureAt(
  shapes: readonly HitShape[],
  toScreen: ToScreen,
  x: number,
  y: number,
  tol = HIT_PX,
): string | null {
  const p: ScreenPt = { x, y };
  let best: string | null = null;
  let bestD = tol;
  const rings: { id: string; ring: ScreenPt[] }[] = [];
  for (const sh of shapes) {
    const pts = sh.points.map((q) => toScreen(q));
    for (const v of pts) {
      if (!v) continue;
      const d = Math.hypot(v.x - x, v.y - y);
      if (d <= bestD) {
        best = sh.id;
        bestD = d;
      }
    }
    const n = pts.length;
    const loop = sh.closed && n >= 3;
    const segs = loop ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (!a || !b) continue;
      const d = distanceToSegment(p, a, b);
      if (d <= bestD) {
        best = sh.id;
        bestD = d;
      }
    }
    if (loop && pts.every((q) => q !== null)) rings.push({ id: sh.id, ring: pts });
  }
  if (best !== null) return best;
  let inner: string | null = null;
  let innerArea = Infinity;
  for (const r of rings) {
    if (!insideRing(p, r.ring)) continue;
    const area = ringArea(r.ring);
    if (area <= innerArea) {
      inner = r.id;
      innerArea = area;
    }
  }
  return inner;
}
