import type { LensModel, Quat, Vec3 } from '@aio/schema';

/** Small geometry helpers of the in-app comparisons (no three.js: main runs them too). */

export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function mean3(points: readonly Vec3[]): Vec3 | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  const n = points.length;
  return [x / n, y / n, z / n];
}

/** Area of a planar 3D polygon (Newell's method), square metres. */
export function polygonArea3(points: readonly Vec3[]): number {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.hypot(nx, ny, nz) / 2;
}

export function polylineLength3(points: readonly Vec3[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) len += dist3(a, b);
  }
  return len;
}

/** Rotate a vector by a unit quaternion [x, y, z, w]. */
function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * Whether a posed camera sees a point inside its image (the camera looks along local -Z, +Y up,
 * as data-conventions section 3 and `annotate/crossview/lens.ts`), within `maxRangeM`.
 */
export function cameraSees(
  pose: { pos: Vec3; q: Quat },
  lens: LensModel,
  p: Vec3,
  maxRangeM: number,
): boolean {
  const rel: Vec3 = [p[0] - pose.pos[0], p[1] - pose.pos[1], p[2] - pose.pos[2]];
  const range = Math.hypot(rel[0], rel[1], rel[2]);
  if (range > maxRangeM) return false;
  if (range < 1e-9) return true;
  const [cx, cy, cz] = rotate([-pose.q[0], -pose.q[1], -pose.q[2], pose.q[3]], rel);
  const forward = -cz / range;
  const half = (lens.hfovDeg * Math.PI) / 360;
  if (lens.model === 'pinhole') {
    if (forward <= 1e-9) return false;
    const x = cx / -cz;
    const y = cy / -cz;
    const tx = Math.tan(half);
    const ty = tx / lens.aspect;
    return Math.abs(x) <= tx && Math.abs(y) <= ty;
  }
  // f-theta: radius in the image grows with the angle off the axis
  const theta = Math.acos(Math.max(-1, Math.min(1, forward)));
  const side = Math.hypot(cx, cy);
  if (side < 1e-12) return true;
  const r = theta / half; // 1 at the left and right edges
  const x = (r * cx) / side;
  const y = (r * cy) / side;
  return Math.abs(x) <= 1 && Math.abs(y) <= 1 / lens.aspect;
}

/* ----------------------------------------------------------------------- lon/lat */

const EARTH_M = 6_371_008.8;

/** Metres east and north of `origin` (equirectangular; fine over a site). */
export function lonLatToMetres(p: readonly number[], origin: readonly number[]): [number, number] {
  const lat0 = ((origin[1] ?? 0) * Math.PI) / 180;
  const dx = ((((p[0] ?? 0) - (origin[0] ?? 0)) * Math.PI) / 180) * EARTH_M * Math.cos(lat0);
  const dy = ((((p[1] ?? 0) - (origin[1] ?? 0)) * Math.PI) / 180) * EARTH_M;
  return [dx, dy];
}

export type XY = readonly [number, number];

export function centroid2(points: readonly XY[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
  }
  const n = Math.max(1, points.length);
  return [x / n, y / n];
}

export interface Box2 {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function box2(points: readonly XY[]): Box2 {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Distance between two boxes (0 when they touch or overlap). */
export function boxGap(a: Box2, b: Box2): number {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
  return Math.hypot(dx, dy);
}

function toSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from a point to a vertex chain (its segments; a single vertex is a point). */
function nearest(p: XY, set: readonly XY[]): number {
  if (set.length === 1 && set[0]) return Math.hypot(p[0] - set[0][0], p[1] - set[0][1]);
  let best = Infinity;
  for (let i = 1; i < set.length; i++) {
    const a = set[i - 1];
    const b = set[i];
    if (a && b) best = Math.min(best, toSegment(p, a, b));
  }
  return best;
}

/** Hausdorff distance between two vertex chains (vertices to the other chain's segments). */
export function hausdorff(a: readonly XY[], b: readonly XY[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  let h = 0;
  for (const p of a) h = Math.max(h, nearest(p, b));
  for (const p of b) h = Math.max(h, nearest(p, a));
  return h;
}
