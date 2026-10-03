import type { LensModel, Quat, Vec2, Vec3 } from '@aio/schema';

/**
 * Lens helpers for back-projection. Camera frame per data-conventions section 3: the camera looks
 * along local -Z, +Y is image up, +X image right. Pixels have their origin top-left.
 *
 * Implemented locally because @aio/video does not export lens helpers yet (seam for stream S6).
 * Pinhole: r = f tan(theta), f = (W/2) / tan(hfov/2).
 * f-theta (equidistant, Elios 3): r = f theta, f = (W/2) / (hfov/2 in radians).
 * The optional f-theta `k` terms are not applied (no source documents their meaning).
 */

export interface CameraPose {
  pos: Vec3;
  q: Quat;
}

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function focalPx(lens: LensModel, width: number): number {
  const half = rad(lens.hfovDeg) / 2;
  return lens.model === 'pinhole' ? width / 2 / Math.tan(half) : width / 2 / half;
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Unit ray direction in the camera frame for an image pixel. */
export function pixelToCameraRay(lens: LensModel, pixel: Vec2, size: Vec2): Vec3 {
  const [w, h] = size;
  const f = focalPx(lens, w);
  const dx = pixel[0] - w / 2;
  const dy = h / 2 - pixel[1];
  if (lens.model === 'pinhole') return normalize([dx / f, dy / f, -1]);
  const r = Math.hypot(dx, dy);
  if (r === 0) return [0, 0, -1];
  const theta = r / f;
  const s = Math.sin(theta) / r;
  return [dx * s, dy * s, -Math.cos(theta)];
}

/** Image pixel of a camera-frame direction, or null when the lens cannot see it. */
export function cameraToPixel(lens: LensModel, dir: Vec3, size: Vec2): Vec2 | null {
  const [w, h] = size;
  const f = focalPx(lens, w);
  const d = normalize(dir);
  const forward = -d[2];
  if (lens.model === 'pinhole') {
    if (forward <= 1e-9) return null;
    return [w / 2 + (f * d[0]) / forward, h / 2 - (f * d[1]) / forward];
  }
  const theta = Math.acos(Math.max(-1, Math.min(1, forward)));
  const side = Math.hypot(d[0], d[1]);
  if (side < 1e-12) return [w / 2, h / 2];
  const r = f * theta;
  return [w / 2 + (r * d[0]) / side, h / 2 - (r * d[1]) / side];
}

/** Rotate a vector by a unit quaternion [x, y, z, w]. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

export function conjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** World ray (local project frame) through a pixel of a posed camera. */
export function pixelToWorldRay(pose: CameraPose, lens: LensModel, pixel: Vec2, size: Vec2): Ray {
  return { origin: pose.pos, dir: normalize(rotate(pose.q, pixelToCameraRay(lens, pixel, size))) };
}

/** Pixel where a world point appears in a posed camera, or null when it is not in the image. */
export function worldToPixel(pose: CameraPose, lens: LensModel, p: Vec3, size: Vec2): Vec2 | null {
  const rel: Vec3 = [p[0] - pose.pos[0], p[1] - pose.pos[1], p[2] - pose.pos[2]];
  const px = cameraToPixel(lens, rotate(conjugate(pose.q), rel), size);
  if (!px) return null;
  const [x, y] = px;
  return x >= 0 && y >= 0 && x <= size[0] && y <= size[1] ? px : null;
}
