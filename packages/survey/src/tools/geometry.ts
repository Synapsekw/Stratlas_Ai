import type { SitePoint } from '@aio/schema';

/**
 * Plane and space geometry on site points (E, N, Z) in the project CRS, metres (float64). The
 * distances here are grid distances; the ground scale factor is applied at display (G1).
 */

export type Pt = SitePoint;

/** A surface the tools sample: height at (E, N), or null where it has no data. */
export interface HeightSampler {
  heightAt(e: number, n: number): number | null;
}

export const horizontalDistance = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

export const slopeDistance = (a: Pt, b: Pt): number =>
  Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** Grid bearing from a to b, degrees clockwise from grid north, 0 to 360. */
export function bearingDeg(a: Pt | readonly [number, number], b: Pt | readonly [number, number]) {
  const deg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** The point `distance` metres from `from` along grid bearing `bearing` (degrees), same Z. */
export function pointAtBearing(from: Pt, bearing: number, distance: number, z = from[2]): Pt {
  const r = (bearing * Math.PI) / 180;
  return [from[0] + distance * Math.sin(r), from[1] + distance * Math.cos(r), z];
}

/** Segments of a line, or of a closed polygon's ring. */
export function segments(points: readonly Pt[], closed = false): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) out.push([a, b]);
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (closed && points.length > 2 && first && last) out.push([last, first]);
  return out;
}

/** A sampled profile along a line: chainage (horizontal), position and the surface height. */
export interface Profile {
  chainage: number[];
  e: number[];
  n: number[];
  z: (number | null)[];
}

/**
 * Sample `sampler` along the line every `stepM` metres (horizontal), always including every
 * vertex, so a profile with breaks at the vertices is followed exactly.
 */
export function sampleProfile(
  points: readonly Pt[],
  sampler: HeightSampler,
  stepM: number,
): Profile {
  if (!(stepM > 0)) throw new RangeError('The sample step must be positive.');
  const out: Profile = { chainage: [], e: [], n: [], z: [] };
  const push = (c: number, e: number, n: number) => {
    out.chainage.push(c);
    out.e.push(e);
    out.n.push(n);
    out.z.push(sampler.heightAt(e, n));
  };
  const first = points[0];
  if (!first) return out;
  push(0, first[0], first[1]);
  let base = 0;
  for (const [a, b] of segments(points)) {
    const len = horizontalDistance(a, b);
    const steps = Math.max(1, Math.ceil(len / stepM - 1e-9));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      push(base + len * t, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    }
    base += len;
  }
  return out;
}

/** Shoelace area of a ring in (E, N), always positive, square metres. */
export function planArea(ring: readonly (Pt | readonly [number, number])[]): number {
  let s = 0;
  const n = ring.length;
  if (n < 3) return 0;
  // relative to the first vertex: projected coordinates are large, the area is not
  const o = ring[0] ?? [0, 0];
  for (let i = 0; i < n; i++) {
    const a = ring[i] ?? o;
    const b = ring[(i + 1) % n] ?? o;
    s += (a[0] - o[0]) * (b[1] - o[1]) - (b[0] - o[0]) * (a[1] - o[1]);
  }
  return Math.abs(s) / 2;
}

/** Area of a 3D polygon through its vertices (Newell's vector area), square metres. */
export function spatialArea(ring: readonly Pt[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  const o = ring[0] ?? [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i] ?? o;
    const b = ring[(i + 1) % n] ?? o;
    const [ax, ay, az] = [a[0] - o[0], a[1] - o[1], a[2] - o[2]];
    const [bx, by, bz] = [b[0] - o[0], b[1] - o[1], b[2] - o[2]];
    x += (ay - by) * (az + bz);
    y += (az - bz) * (ax + bx);
    z += (ax - bx) * (ay + by);
  }
  return Math.hypot(x, y, z) / 2;
}

/** Perimeter of a closed ring in plan, metres. */
export const planPerimeter = (ring: readonly Pt[]): number =>
  segments(ring, true).reduce((s, [a, b]) => s + horizontalDistance(a, b), 0);

/** Clip a ring (E, N) to an axis-aligned rectangle (Sutherland-Hodgman). */
export function clipToRect(
  ring: readonly (readonly [number, number])[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number][] {
  type P = [number, number];
  let poly: P[] = ring.map((p) => [p[0], p[1]]);
  const edges: { inside: (p: P) => boolean; cut: (a: P, b: P) => P }[] = [
    { inside: (p) => p[0] >= x0, cut: (a, b) => lerpX(a, b, x0) },
    { inside: (p) => p[0] <= x1, cut: (a, b) => lerpX(a, b, x1) },
    { inside: (p) => p[1] >= y0, cut: (a, b) => lerpY(a, b, y0) },
    { inside: (p) => p[1] <= y1, cut: (a, b) => lerpY(a, b, y1) },
  ];
  for (const edge of edges) {
    if (poly.length === 0) break;
    const input = poly;
    poly = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (!cur || !prev) continue;
      const ci = edge.inside(cur);
      const pi = edge.inside(prev);
      if (ci) {
        if (!pi) poly.push(edge.cut(prev, cur));
        poly.push(cur);
      } else if (pi) poly.push(edge.cut(prev, cur));
    }
  }
  return poly;
}

function lerpX(a: [number, number], b: [number, number], x: number): [number, number] {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + (b[1] - a[1]) * t];
}
function lerpY(a: [number, number], b: [number, number], y: number): [number, number] {
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + (b[0] - a[0]) * t, y];
}

/** Is (e, n) inside the ring (even-odd)? */
export function inRing(ring: readonly (Pt | readonly [number, number])[], e: number, n: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    if (a[1] > n !== b[1] > n && e < ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

/** The closest point to p on segment ab (in the plane given by the first two coordinates). */
export function closestOnSegment2(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): { t: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { t, d: Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)) };
}

export const lerp3 = (a: Pt, b: Pt, t: number): Pt => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
