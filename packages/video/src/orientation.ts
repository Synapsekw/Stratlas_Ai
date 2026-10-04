import type { CameraOrientation, Quat, Vec3 } from '@aio/schema';

/**
 * Camera orientation bias of a clip (`CameraOrientation` in @aio/schema): a small turn in the
 * camera frame after the logged orientation, `q = qLog * Ry(yaw) * Rx(pitch) * Rz(roll)`, which is
 * the three.js Euler order 'YXZ'. Positive pitch tilts the view up, positive yaw turns it left.
 */

export const NO_ORIENTATION: CameraOrientation = { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

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

export function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Rotate vector `v` by unit quaternion `q`. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const p = quatMul(quatMul(q, [v[0], v[1], v[2], 0]), quatConj(q));
  return [p[0], p[1], p[2]];
}

/** The bias as a quaternion: yaw about +Y, then pitch about +X, then roll about +Z (degrees). */
export function biasQuat(o: CameraOrientation | null | undefined): Quat {
  if (!o) return [0, 0, 0, 1];
  const h = (d: number) => (d * Math.PI) / 360;
  const y: Quat = [0, Math.sin(h(o.yawDeg)), 0, Math.cos(h(o.yawDeg))];
  const x: Quat = [Math.sin(h(o.pitchDeg)), 0, 0, Math.cos(h(o.pitchDeg))];
  const z: Quat = [0, 0, Math.sin(h(o.rollDeg)), Math.cos(h(o.rollDeg))];
  return quatMul(quatMul(y, x), z);
}

/** The calibrated camera orientation: the logged one turned by the clip's bias. */
export function orientCamera(q: Quat, o: CameraOrientation | null | undefined): Quat {
  if (!o || (o.yawDeg === 0 && o.pitchDeg === 0 && o.rollDeg === 0)) return q;
  const r = quatMul(q, biasQuat(o));
  const n = Math.hypot(r[0], r[1], r[2], r[3]);
  return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
}

/** Yaw, pitch and roll (degrees, Euler 'YXZ') of a camera-frame turn: inverse of `biasQuat`. */
export function orientationFromQuat(q: Quat): CameraOrientation {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const [x, y, z, w] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  const m11 = 1 - 2 * (y * y + z * z);
  const m13 = 2 * (x * z + y * w);
  const m21 = 2 * (x * y + z * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m31 = 2 * (x * z - y * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const D = 180 / Math.PI;
  const pitch = Math.asin(Math.min(1, Math.max(-1, -m23)));
  let yaw: number;
  let roll: number;
  if (Math.abs(m23) < 0.9999999) {
    yaw = Math.atan2(m13, m33);
    roll = Math.atan2(m21, m22);
  } else {
    yaw = Math.atan2(-m31, m11);
    roll = 0;
  }
  return { yawDeg: yaw * D, pitchDeg: pitch * D, rollDeg: roll * D };
}

/** Compose two biases (`a` first, then `b` in the turned frame) into one. */
export function composeOrientation(
  a: CameraOrientation | null | undefined,
  b: CameraOrientation | null | undefined,
): CameraOrientation {
  return orientationFromQuat(quatMul(biasQuat(a), biasQuat(b)));
}

/** True when the bias turns the camera by less than `epsDeg` on every axis. */
export function isZeroOrientation(o: CameraOrientation | null | undefined, epsDeg = 1e-6): boolean {
  return (
    !o ||
    (Math.abs(o.yawDeg) < epsDeg && Math.abs(o.pitchDeg) < epsDeg && Math.abs(o.rollDeg) < epsDeg)
  );
}
