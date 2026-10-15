import type { FrameGeom, ImageGeom, Vec2 } from '@aio/schema';

/**
 * 2D helpers of the projector (findings on a model): shape outlines in image pixels, samples
 * along and inside them, and plan-view hulls in metres. Pure.
 */

/** The outline of a box, rotated box or polygon, in image pixels; null for points and masks. */
export function outlineOf(g: ImageGeom | FrameGeom): Vec2[] | null {
  switch (g.type) {
    case 'box':
      return [
        [g.x, g.y],
        [g.x + g.w, g.y],
        [g.x + g.w, g.y + g.h],
        [g.x, g.y + g.h],
      ];
    case 'rotbox': {
      const cx = g.x + g.w / 2;
      const cy = g.y + g.h / 2;
      const a = (g.angleDeg * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const corners: Vec2[] = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      return corners.map(([u, v]): Vec2 => {
        const dx = (u * g.w) / 2;
        const dy = (v * g.h) / 2;
        return [cx + dx * c - dy * s, cy + dx * s + dy * c];
      });
    }
    case 'polygon':
      return g.points.map((p): Vec2 => [p[0], p[1]]);
    default:
      return null;
  }
}

/** Samples along a closed ring, one every `step` (the corners included). */
export function densify(ring: readonly Vec2[], step = 8): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Even-odd point in ring. */
export function pointInRing(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** The cell centres of an n x n grid over the ring's bounds that fall inside it. */
export function gridInside(ring: readonly Vec2[], n = 7): Vec2[] {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const out: Vec2[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const p: Vec2 = [x0 + ((i + 0.5) * (x1 - x0)) / n, y0 + ((j + 0.5) * (y1 - y0)) / n];
      if (pointInRing(p, ring)) out.push(p);
    }
  return out;
}

export function ringArea(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

const turn = (o: Vec2, a: Vec2, b: Vec2) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull, counter-clockwise, no repeated points (Andrew's monotone chain). */
export function convexHull2(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (list: readonly Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (out.length >= 2) {
        const a = out[out.length - 2];
        const b = out[out.length - 1];
        if (a && b && turn(a, b, p) <= 0) out.pop();
        else break;
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** The smallest width of a convex hull (0 for fewer than three points). */
export function hullWidth(hull: readonly Vec2[]): number {
  if (hull.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    let far = 0;
    for (const p of hull)
      far = Math.max(
        far,
        Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len,
      );
    best = Math.min(best, far);
  }
  return best === Infinity ? 0 : best;
}

const OCTAGON: Vec2[] = Array.from({ length: 8 }, (_, k): Vec2 => [
  Math.cos((k * Math.PI) / 4),
  Math.sin((k * Math.PI) / 4),
]);

/**
 * The hull of `points`, grown to at least `minWidth` across when it is thinner (like the Cloud
 * box tool's padding): every point is widened by an octagon whose inner radius is minWidth / 2.
 */
export function padHull(points: readonly Vec2[], minWidth: number): Vec2[] {
  const hull = convexHull2(points);
  if (hull.length >= 3 && hullWidth(hull) >= minWidth) return hull;
  const r = minWidth / 2 / Math.cos(Math.PI / 8);
  const grown: Vec2[] = [];
  for (const [x, y] of hull) for (const [dx, dy] of OCTAGON) grown.push([x + dx * r, y + dy * r]);
  return convexHull2(grown);
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length === 0) return 0;
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

/** Median absolute deviation around `centre`. */
export function mad(xs: readonly number[], centre: number): number {
  return median(xs.map((x) => Math.abs(x - centre)));
}
