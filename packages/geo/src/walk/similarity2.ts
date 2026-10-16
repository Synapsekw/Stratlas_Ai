import type { XZ } from './horizontal';

/** A 2D similarity on `[x, z]`: `p' = s * R * p + t`, `R = [[cos, -sin], [sin, cos]]`. */
export interface Sim2 {
  s: number;
  cos: number;
  sin: number;
  tx: number;
  tz: number;
}

/**
 * The similarity taking `a0` to `b0` and `a1` to `b1` exactly, in complex form
 * (`m = (b1 - b0) / (a1 - a0)`, translation `b0 - m * a0`). Null when `a0` and `a1` coincide.
 */
export function sim2FromPairs(a0: XZ, a1: XZ, b0: XZ, b1: XZ): Sim2 | null {
  const ax = a1[0] - a0[0];
  const az = a1[1] - a0[1];
  const bx = b1[0] - b0[0];
  const bz = b1[1] - b0[1];
  const den = ax * ax + az * az;
  if (!Number.isFinite(den) || Math.sqrt(den) < 1e-9) return null;
  // m = b / a = b * conj(a) / |a|^2
  const mr = (bx * ax + bz * az) / den;
  const mi = (bz * ax - bx * az) / den;
  const s = Math.hypot(mr, mi);
  if (!Number.isFinite(s) || s === 0) return null;
  return {
    s,
    cos: mr / s,
    sin: mi / s,
    tx: b0[0] - (mr * a0[0] - mi * a0[1]),
    tz: b0[1] - (mi * a0[0] + mr * a0[1]),
  };
}

/**
 * The similarity taking raw pair `a0`, `a1` onto target pair `b0`, `b1`. When the targets are the
 * same place but the raw points are not (a walk that returns to its start), the raw shape is kept
 * in its own metres and heading, anchored on the start. Null when the raw points coincide.
 */
export function sim2Between(a0: XZ, a1: XZ, b0: XZ, b1: XZ): Sim2 | null {
  const mapped = sim2FromPairs(a0, a1, b0, b1);
  if (mapped) return mapped;
  const raw = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
  const target = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
  if (raw >= 1e-9 && target < 1e-4) {
    return { s: 1, cos: 1, sin: 0, tx: b0[0] - a0[0], tz: b0[1] - a0[1] };
  }
  return null;
}

export function applySim2(m: Sim2, p: XZ): XZ {
  const x = m.s * (m.cos * p[0] - m.sin * p[1]) + m.tx;
  const z = m.s * (m.sin * p[0] + m.cos * p[1]) + m.tz;
  return [x, z];
}

/** The same rotation and scale as `m`, translated so `a` lands on `b`. */
export function sim2Through(m: Sim2, a: XZ, b: XZ): Sim2 {
  const moved = applySim2({ ...m, tx: 0, tz: 0 }, a);
  return { ...m, tx: b[0] - moved[0], tz: b[1] - moved[1] };
}

/**
 * The turn of `m` as a heading change about +Y (a three.js `Ry` angle). On `[x, z]` a complex
 * turn by `phi` is `Ry(-phi)`.
 */
export function sim2Yaw(m: Sim2): number {
  return -Math.atan2(m.sin, m.cos);
}
