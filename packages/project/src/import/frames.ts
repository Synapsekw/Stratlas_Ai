import type { Mat4, Quat, Vec3 } from '@aio/schema';
import {
  add,
  quatConjugate,
  quatFromAxisAngle,
  quatMultiply,
  quatRotate,
  quatToMat3,
} from './math';

/**
 * A rigid map from a source frame into the project local frame
 * (data-conventions section 1: metres, Y up, X east, Z south):
 * `local = rotation * source + offset`.
 */
export interface FrameMap {
  readonly rotation: Quat;
  readonly offset: Vec3;
}

/** Rotation about +Y (up) by `deg`, right-handed (counter-clockwise seen from above). */
export function rotateY(deg: number): Quat {
  return quatFromAxisAngle([0, 1, 0], (deg * Math.PI) / 180);
}

export function composeFrame(rotation: Quat, offset: Vec3 = [0, 0, 0]): FrameMap {
  return { rotation, offset };
}

/**
 * Asset Inspection Kit tank frame (Y up, X plant north, Z plant east) to local
 * (X east, Y up, Z south): `x = z_kit`, `y = y_kit`, `z = -x_kit`, a +90 deg turn about Y.
 * Plant north is taken as grid north (the source does not give the true-north offset sign).
 */
export const KIT_FRAME: FrameMap = composeFrame(rotateY(90));

export function mapPoint(f: FrameMap, p: Vec3): Vec3 {
  return add(quatRotate(f.rotation, p), f.offset);
}

/** Rotate a direction (no offset). */
export function mapDir(f: FrameMap, d: Vec3): Vec3 {
  return quatRotate(f.rotation, d);
}

/**
 * Map an orientation expressed in the source frame (object-to-source rotation) into the local
 * frame. For a three.js camera quaternion the camera still looks down its own -Z afterwards.
 */
export function mapQuat(f: FrameMap, q: Quat): Quat {
  return quatMultiply(f.rotation, q);
}

export function invertFrame(f: FrameMap): FrameMap {
  const inv = quatConjugate(f.rotation);
  const o = quatRotate(inv, f.offset);
  return { rotation: inv, offset: [-o[0], -o[1], -o[2]] };
}

/** Column-major 4x4 (three.js `Matrix4.elements` order) for a mesh layer `transform`. */
export function meshTransform(f: FrameMap): Mat4 {
  const r = quatToMat3(f.rotation);
  const c = (i: number, j: number) => r[i]?.[j] ?? 0;
  const clean = (v: number) => (Math.abs(v) < 1e-15 ? 0 : v);
  return [
    c(0, 0),
    c(1, 0),
    c(2, 0),
    0,
    c(0, 1),
    c(1, 1),
    c(2, 1),
    0,
    c(0, 2),
    c(1, 2),
    c(2, 2),
    0,
    f.offset[0],
    f.offset[1],
    f.offset[2],
    1,
  ].map(clean);
}

export function applyMat4(m: Mat4, p: Vec3): Vec3 {
  const e = (i: number) => m[i] ?? 0;
  const [x, y, z] = p;
  const w = e(3) * x + e(7) * y + e(11) * z + e(15);
  return [
    (e(0) * x + e(4) * y + e(8) * z + e(12)) / w,
    (e(1) * x + e(5) * y + e(9) * z + e(13)) / w,
    (e(2) * x + e(6) * y + e(10) * z + e(14)) / w,
  ];
}
