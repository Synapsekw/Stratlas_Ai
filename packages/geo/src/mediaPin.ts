import type { Quat, Vec3 } from '@aio/schema';
import { cameraQuatFromGimbal } from './camera';

/* Pure maths for pinned media: bearings on the site, headings from landmark pairs and the
 * compass bearing of a click in a 360 view. Local frame: x east, y up, z south; headings are
 * degrees clockwise from grid north. */

const D = Math.PI / 180;

/** Default eye height of a pinned camera, metres. */
export const DEFAULT_EYE_M = 1.6;
/** A landmark closer than this (horizontally) to the pin gives no usable bearing. */
export const MIN_BEARING_M = 0.5;

/** An angle wrapped to `[0, 360)`. */
export function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Compass bearing from `from` to `to`, or null when they are under `MIN_BEARING_M` apart. */
export function bearingDeg(from: Vec3, to: Vec3): number | null {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (Math.hypot(dx, dz) < MIN_BEARING_M) return null;
  return wrap360(Math.atan2(dx, -dz) / D);
}

/** `a - b` as a signed angle in `(-180, 180]`. */
export function bearingDiffDeg(a: number, b: number): number {
  return 180 - wrap360(180 - (a - b));
}

/** One landmark seen twice: its bearing in the 360's own frame and its bearing on the site. */
export interface LandmarkPair {
  offsetDeg: number;
  worldDeg: number;
}

/** The heading that turns the 360's frame onto the site for one pair. */
export function headingFromPair(p: LandmarkPair): number {
  return wrap360(p.worldDeg - p.offsetDeg);
}

/** Circular mean of angles, or null when there are none or they cancel out. */
export function circularMeanDeg(angles: readonly number[]): number | null {
  let s = 0;
  let c = 0;
  for (const a of angles) {
    s += Math.sin(a * D);
    c += Math.cos(a * D);
  }
  if (angles.length === 0 || Math.hypot(s, c) / angles.length < 1e-6) return null;
  return wrap360(Math.atan2(s, c) / D);
}

/** The heading from any number of pairs (their circular mean), or null when they cancel out. */
export function headingFromPairs(pairs: readonly LandmarkPair[]): number | null {
  return circularMeanDeg(pairs.map(headingFromPair));
}

/** The camera place for a pin: `ground` lifted by `eyeM`. */
export function eyePos(ground: Vec3, eyeM: number): Vec3 {
  return [ground[0], ground[1] + eyeM, ground[2]];
}

/** A level camera looking along `headingDeg`. */
export function photoQuatFromHeading(headingDeg: number): Quat {
  return cameraQuatFromGimbal(headingDeg, 0, 0);
}

/** The pano view that clicks are measured in. */
export interface LookLike {
  yawDeg: number;
  pitchDeg: number;
  fovDeg: number;
}

/**
 * Compass bearing of a click at pixel `(x, y)` in a `w` x `h` view of the 360 (`fovDeg` is the
 * vertical field of view), looking along `yawDeg` / `pitchDeg`.
 */
export function lookClickBearingDeg(
  look: LookLike,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const t = Math.tan((look.fovDeg * D) / 2);
  const rx = ((2 * x) / w - 1) * t * (w / h);
  const ry = (1 - (2 * y) / h) * t;
  // Camera ray (rx, ry, -1), pitched about +x, then turned by -yaw about +y.
  const cp = Math.cos(look.pitchDeg * D);
  const sp = Math.sin(look.pitchDeg * D);
  const pz = ry * sp - cp;
  const th = -look.yawDeg * D;
  const dx = rx * Math.cos(th) + pz * Math.sin(th);
  const dz = -rx * Math.sin(th) + pz * Math.cos(th);
  return wrap360(Math.atan2(dx, -dz) / D);
}
