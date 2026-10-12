import type { Quat, Vec3, WalkRawPath } from '@aio/schema';

/** A horizontal position in the model frame (or the levelled raw frame): `[x, z]`. */
export type XZ = [number, number];

const IDENTITY: Quat = [0, 0, 0, 1];

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

export function quatNormalise(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(len) || len === 0) return IDENTITY;
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** `v` turned by the unit quaternion `q`. */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** The shortest rotation taking the unit vector `from` onto the unit vector `to`. */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  let r = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + 1;
  let q: Quat;
  if (r < 1e-9) {
    // Opposite vectors: half a turn about any axis square to `from`.
    r = 0;
    q =
      Math.abs(from[0]) > Math.abs(from[2]) ? [-from[1], from[0], 0, r] : [0, -from[2], from[1], r];
  } else {
    q = [
      from[1] * to[2] - from[2] * to[1],
      from[2] * to[0] - from[0] * to[2],
      from[0] * to[1] - from[1] * to[0],
      r,
    ];
  }
  return quatNormalise(q);
}

/** Yaw (about +Y), pitch (about +X) and roll (about +Z) of `q`, three.js `YXZ` order, radians. */
export function yawPitchRoll(q: Quat): { yaw: number; pitch: number; roll: number } {
  const [x, y, z, w] = q;
  const m13 = 2 * (x * z + w * y);
  const m23 = 2 * (y * z - w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const m21 = 2 * (x * y + w * z);
  const m22 = 1 - 2 * (x * x + z * z);
  const m31 = 2 * (x * z - w * y);
  const m11 = 1 - 2 * (y * y + z * z);
  const pitch = Math.asin(-Math.min(1, Math.max(-1, m23)));
  if (Math.abs(m23) < 0.9999999) {
    return { yaw: Math.atan2(m13, m33), pitch, roll: Math.atan2(m21, m22) };
  }
  return { yaw: Math.atan2(-m31, m11), pitch, roll: 0 };
}

/** `Ry(yaw) * Rx(pitch) * Rz(roll)` as a quaternion (three.js `YXZ` order), radians. */
export function quatFromYawPitchRoll(yaw: number, pitch: number, roll: number): Quat {
  const c1 = Math.cos(pitch / 2);
  const c2 = Math.cos(yaw / 2);
  const c3 = Math.cos(roll / 2);
  const s1 = Math.sin(pitch / 2);
  const s2 = Math.sin(yaw / 2);
  const s3 = Math.sin(roll / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

/** The heading (a `Ry` angle, three.js: 0 looks down -Z) of a travel direction `[dx, dz]`. */
export function headingOf(d: XZ): number {
  return Math.atan2(-d[0], -d[1]);
}

/** `a` minus `b`, wrapped to (-pi, pi]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * The rotation that levels the raw frame: its `up` onto +Y, or, when `up` is absent, the mean of
 * the registered stills' camera up axes (the camera down axes negated). Identity when neither is
 * usable.
 */
export function levelRotation(raw: WalkRawPath): Quat {
  let up: Vec3;
  if (raw.up?.every(Number.isFinite)) up = raw.up;
  else {
    const sum: Vec3 = [0, 0, 0];
    for (const s of raw.stills) {
      if (!s.q) continue;
      const a = rotateVec(quatNormalise(s.q), [0, 1, 0]);
      sum[0] += a[0];
      sum[1] += a[1];
      sum[2] += a[2];
    }
    up = sum;
  }
  const len = Math.hypot(up[0], up[1], up[2]);
  if (!Number.isFinite(len) || len < 1e-12) return IDENTITY;
  return quatFromUnitVectors([up[0] / len, up[1] / len, up[2] / len], [0, 1, 0]);
}

/** One still of the levelled raw path. */
export interface LevelStill {
  n: number;
  t: number;
  /** Levelled raw `[x, z]`; null when the still was not registered. */
  xz: XZ | null;
  /** Levelled raw camera orientation; null when not registered or unknown. */
  q: Quat | null;
  segment: number | null;
  steps: number;
}

/** The raw path levelled (see {@link levelRotation}) with its stills sorted by time. */
export function levelStills(raw: WalkRawPath): LevelStill[] {
  const r = levelRotation(raw);
  const out = raw.stills
    .filter((s) => Number.isFinite(s.t))
    .map((s): LevelStill => {
      const pos = s.pos?.every(Number.isFinite) ? rotateVec(r, s.pos) : null;
      const q = pos && s.q ? quatNormalise(quatMul(r, quatNormalise(s.q))) : null;
      return {
        n: s.n,
        t: s.t,
        xz: pos ? [pos[0], pos[2]] : null,
        q,
        segment: pos ? (s.segment ?? 0) : null,
        steps: Number.isFinite(s.steps) ? s.steps : 0,
      };
    });
  return out.sort((a, b) => a.t - b.t);
}

/** The raw path seen from above: levelled `[x, z]` per still, stills sorted by time. */
export function horizontalPath(raw: WalkRawPath): {
  t: number[];
  xz: (XZ | null)[];
  segment: (number | null)[];
  steps: number[];
} {
  const stills = levelStills(raw);
  return {
    t: stills.map((s) => s.t),
    xz: stills.map((s) => s.xz),
    segment: stills.map((s) => s.segment),
    steps: stills.map((s) => s.steps),
  };
}
