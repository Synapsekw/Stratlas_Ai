import { shiftLocal, type DateShift, type Issue } from '@aio/schema';

/**
 * Plan-view footprints of issues placed as areas on a model (findings on a model): the convex
 * hull of a mesh outline (`spolygon`) or a cloud prism ring (`polygon3`) in (x, z), and the
 * overlap of two footprints as the intersection over the smaller area. Pure.
 */
export type XZ = readonly [number, number];

/** Two placed areas are the same defect when they overlap at least this much. */
export const MIN_OVERLAP = 0.3;

const cross = (o: XZ, a: XZ, b: XZ) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull, counter-clockwise (x right, z up), no repeated points (Andrew's monotone chain). */
export function convexHullXZ(points: readonly XZ[]): XZ[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (list: readonly XZ[]): XZ[] => {
    const out: XZ[] = [];
    for (const p of list) {
      while (out.length >= 2) {
        const a = out[out.length - 2];
        const b = out[out.length - 1];
        if (a && b && cross(a, b, p) <= 0) out.pop();
        else break;
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

export function areaXZ(ring: readonly XZ[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a && b) s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** Sutherland-Hodgman: the part of convex `subject` inside convex `clip` (both counter-clockwise). */
export function clipConvex(subject: readonly XZ[], clip: readonly XZ[]): XZ[] {
  let out: XZ[] = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    if (!a || !b) continue;
    const input = out;
    out = [];
    const inside = (p: XZ) => cross(a, b, p) >= 0;
    const meet = (p: XZ, q: XZ): XZ => {
      const dp = cross(a, b, p);
      const dq = cross(a, b, q);
      const t = dp / (dp - dq);
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    };
    for (let k = 0; k < input.length; k++) {
      const p = input[k];
      const q = input[(k + 1) % input.length];
      if (!p || !q) continue;
      if (inside(q)) {
        if (!inside(p)) out.push(meet(p, q));
        out.push(q);
      } else if (inside(p)) out.push(meet(p, q));
    }
  }
  return out.length >= 3 ? out : [];
}

export function footprintOverlap(a: readonly XZ[], b: readonly XZ[]): number {
  const small = Math.min(areaXZ(a), areaXZ(b));
  if (small <= 0) return 0;
  return areaXZ(clipConvex(convexHullXZ(a), convexHullXZ(b))) / small;
}

/** The issue's plan-view footprint: its first outline or prism, as a convex hull. */
export function footprintOf(
  issue: Pick<Issue, 'sightings'>,
  shiftOf?: (layerId: string) => DateShift | null,
): XZ[] | null {
  for (const s of issue.sightings) {
    const pts =
      s.on === 'mesh' && s.geom.type === 'spolygon'
        ? s.geom.points
        : s.on === 'pointcloud' && s.geom.type === 'polygon3'
          ? s.geom.points
          : null;
    if (!pts) continue;
    const at = shiftOf?.(s.layer) ?? null;
    const hull = convexHullXZ(
      pts.map((p): XZ => {
        const q = shiftLocal(p, at);
        return [q[0], q[2]];
      }),
    );
    if (hull.length >= 3 && areaXZ(hull) > 1e-9) return hull;
  }
  return null;
}
