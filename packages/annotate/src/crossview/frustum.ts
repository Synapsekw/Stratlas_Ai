import type { LensModel, Vec2, Vec3 } from '@aio/schema';
import { focalPx, pixelToCameraRay, rotate, type CameraPose } from './lens';

/** A plane as [nx, ny, nz, d]: a point p is inside when n . p + d >= 0. */
export type Plane4 = [number, number, number, number];

/** What a posed photo sees, for loading point-cloud detail there (`refineAround`). */
export interface PhotoFrustum {
  eye: Vec3;
  planes: Plane4[];
  /** The photo's focal length in pixels: pixels per metre at distance 1. */
  pxPerM: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The six planes of a photo's view: four through its corner rays, near and far. */
export function photoFrustum(
  pose: CameraPose,
  lens: LensModel,
  size: Vec2,
  near = 0.3,
  far = 1000,
): PhotoFrustum {
  const [w, h] = size;
  const corners: Vec2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const rays = corners.map((c) => rotate(pose.q, pixelToCameraRay(lens, c, size)));
  const fwd = unit(rotate(pose.q, [0, 0, -1]));
  const planes: Plane4[] = [];
  for (let i = 0; i < 4; i++) {
    const a = rays[i];
    const b = rays[(i + 1) % 4];
    if (!a || !b) continue;
    let n = unit(cross(a, b));
    if (dot(n, fwd) < 0) n = [-n[0], -n[1], -n[2]];
    planes.push([n[0], n[1], n[2], -dot(n, pose.pos)]);
  }
  const at = (d: number): Vec3 => [
    pose.pos[0] + fwd[0] * d,
    pose.pos[1] + fwd[1] * d,
    pose.pos[2] + fwd[2] * d,
  ];
  planes.push([fwd[0], fwd[1], fwd[2], -dot(fwd, at(near))]);
  planes.push([-fwd[0], -fwd[1], -fwd[2], dot(fwd, at(far))]);
  return { eye: pose.pos, planes, pxPerM: focalPx(lens, w) };
}
