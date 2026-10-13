import type { Quat, Vec3 } from '@aio/schema';
import { rayToImage, rotate, type ViewPose } from '@aio/video';
import { groundDistance } from '../panoPair';
import { SPOT_RULES } from './spotRules';

/** Geometry of the spot search: compass bearings, wrapped angles, flat ground, image points. */
export { groundDistance, rotate };

const R2D = 180 / Math.PI;

export const wrapDeg = (a: number): number => ((a % 360) + 360) % 360;

/** The angle between two bearings, 0 to 180 degrees. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(wrapDeg(a) - wrapDeg(b));
  return d > 180 ? 360 - d : d;
}

export const distance3 = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The compass bearing of a direction, or undefined when it points (almost) straight up or down. */
export function bearingOf(d: Vec3): number | undefined {
  const n = Math.hypot(d[0], d[1], d[2]);
  const h = Math.hypot(d[0], d[2]);
  if (!(n > 0) || h / n < SPOT_RULES.minHorizontal) return undefined;
  return wrapDeg(Math.atan2(d[0], -d[2]) * R2D);
}

export function bearingTo(from: Vec3, to: Vec3): number | undefined {
  return bearingOf([to[0] - from[0], 0, to[2] - from[2]]);
}

/** The level unit direction of a compass bearing. */
export function levelDir(bearingDeg: number): Vec3 {
  const a = bearingDeg / R2D;
  return [Math.sin(a), 0, -Math.cos(a)];
}

/** Hamilton product of `[x, y, z, w]` quaternions. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Where world point `p` falls in the camera's image (normalised; 0 to 1 is inside), or null. */
export function imagePointOf(pose: ViewPose, p: Vec3): [number, number] | null {
  const d: Vec3 = [p[0] - pose.pos[0], p[1] - pose.pos[1], p[2] - pose.pos[2]];
  return rayToImage(pose.lens, rotate([-pose.q[0], -pose.q[1], -pose.q[2], pose.q[3]], d));
}

export const inFrame = (uv: readonly [number, number]): boolean =>
  uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;

export const centreOffset = (uv: readonly [number, number]): number =>
  Math.hypot(uv[0] - 0.5, uv[1] - 0.5);

/** Where a centre line meets flat ground `groundY` within `rangeM` horizontally, else null. */
export function groundHit(pos: Vec3, dir: Vec3, groundY: number, rangeM: number): Vec3 | null {
  const h = pos[1] - groundY;
  if (!(h > 0) || !(dir[1] < -1e-9)) return null;
  const t = h / -dir[1];
  if (Math.hypot(dir[0], dir[2]) * t > rangeM) return null;
  return [pos[0] + dir[0] * t, groundY, pos[2] + dir[2] * t];
}

/** The ground point `aheadM` along a bearing, or straight below without one. */
export function groundAhead(
  pos: Vec3,
  bearingDeg: number | undefined,
  groundY: number,
  aheadM: number,
): Vec3 {
  if (bearingDeg === undefined) return [pos[0], groundY, pos[2]];
  const d = levelDir(bearingDeg);
  return [pos[0] + d[0] * aheadM, groundY, pos[2] + d[2] * aheadM];
}
