import type { PoseSample, Quat, WalkCalibration, WalkRawPath } from '@aio/schema';
import { WALK_HEIGHT_M } from '@aio/schema';
import { slerpQuat } from '../direction';
import { walkFitDetail, type WalkFit } from './fit';
import {
  levelStills,
  quatFromYawPitchRoll,
  quatMul,
  quatNormalise,
  yawPitchRoll,
  type XZ,
} from './horizontal';

/** Pose samples per second with an orientation file (decimated from it). */
export const WALK_POSE_HZ_ORIENTED = 30;
/** Pose samples per second without one (the stills' orientation, slerped). */
export const WALK_POSE_HZ_STILLS = 10;

/** The walk's line and its kept stills in the model, for the map and the 3D view. */
export function walkPathPoints(
  fit: WalkFit,
  raw: WalkRawPath | null,
  durationS: number,
): { line: { xz: XZ; dashed: boolean }[][]; stills: { n: number; t: number; xz: XZ }[] } {
  const maxT = Number.isFinite(durationS) && durationS > 0 ? durationS : Infinity;
  const stills = raw ? levelStills(raw) : [];
  let times: number[];
  if (stills.length > 0) times = stills.map((s) => s.t);
  else {
    const end = Number.isFinite(maxT) ? maxT : Math.max(0, ...fit.pins.map((p) => p.t));
    times = [
      ...Array.from({ length: Math.floor(end) + 1 }, (_, k) => k),
      ...fit.pins.map((p) => p.t),
    ];
  }
  times = [...new Set(times.filter((t) => t >= 0 && t <= maxT))].sort((a, b) => a - b);

  const line: { xz: XZ; dashed: boolean }[][] = [];
  let current: { xz: XZ; dashed: boolean }[] = [];
  let prev: { xz: XZ; dashed: boolean } | null = null;
  for (const t of times) {
    const a = fit.at(t);
    if (!a) continue;
    const point = { xz: a.xz, dashed: a.dashed };
    if (prev && prev.dashed !== point.dashed) {
      line.push(current);
      // The new run starts where the last one ended, so the line stays joined.
      current = [{ xz: prev.xz, dashed: point.dashed }];
    }
    current.push(point);
    prev = point;
  }
  if (current.length > 0) line.push(current);

  const kept = raw?.kept ? new Set(raw.kept) : null;
  const out: { n: number; t: number; xz: XZ }[] = [];
  for (const s of stills) {
    if (kept && !kept.has(s.n)) continue;
    if (s.t < 0 || s.t > maxT) continue;
    const a = fit.at(s.t);
    if (a) out.push({ n: s.n, t: s.t, xz: a.xz });
  }
  return { line, stills: out };
}

const quatConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Orientation rows (`[t, qx, qy, qz, qw]`, t in playback seconds, sorted) slerped at t. */
function rowAt(rows: readonly Float64Array[], t: number): Quat | null {
  if (rows.length === 0) return null;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((rows[mid]?.[0] ?? Infinity) <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = rows[lo];
  const b = rows[lo + 1] ?? a;
  if (!a || !b) return null;
  const qa: Quat = [a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 1];
  const qb: Quat = [b[1] ?? 0, b[2] ?? 0, b[3] ?? 0, b[4] ?? 1];
  const ta = a[0] ?? 0;
  const tb = b[0] ?? 0;
  const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
  return quatNormalise(slerpQuat(qa, qb, f));
}

/**
 * The walk's pose samples for its `aio.flight/1` file: 30 per second with orientation rows
 * (`readWalkOrientationData`), else 10 per second from the stills; `t` in milliseconds from 0;
 * position through the fit at the camera height; `q = Ry(heading + yawOffset)` composed with the
 * raw camera pitch and roll. Empty while the walk is not placed. The raw path itself is read
 * through the fit (its stills anchor the orientation rows); `_raw` stays in the signature.
 */
export function walkPoseSamples(
  fit: WalkFit,
  _raw: WalkRawPath | null,
  orient: readonly Float64Array[] | null,
  cal: WalkCalibration,
  durationS: number,
): PoseSample[] {
  const rows = orient && orient.length > 0 ? orient : null;
  const hz = rows ? WALK_POSE_HZ_ORIENTED : WALK_POSE_HZ_STILLS;
  const end = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
  const count = Math.floor(end * hz + 1e-9) + 1;
  const heightM = Number.isFinite(cal.heightM) ? cal.heightM : WALK_HEIGHT_M;
  const yawOffset = Number.isFinite(cal.yawOffsetDeg) ? (cal.yawOffsetDeg * Math.PI) / 180 : 0;

  const out: PoseSample[] = [];
  for (let k = 0; k < count; k++) {
    const t = k / hz;
    const d = walkFitDetail(fit, t);
    if (!d) return [];
    // Orientation rows are a relative rotation: turned from the nearest registered still of the
    // same segment, `qStill * inverse(qRow(still.t)) * qRow(t)`. Never levelled on their own, so
    // a constant offset of the gyro frame cancels. Without a still (dashed, pins-only) the
    // heading is the travel direction and the stills' orientation (if any) gives pitch and roll.
    let rawQ = d.rawQ;
    let heading = d.headingRad;
    const rowT = rows ? rowAt(rows, t) : null;
    const rowS = rows && d.still ? rowAt(rows, d.still.t) : null;
    if (d.still && rowT && rowS) {
      rawQ = quatNormalise(quatMul(quatMul(d.still.q, quatConj(rowS)), rowT));
      if (d.fitYaw !== null) heading = d.fitYaw + yawPitchRoll(rawQ).yaw;
    }
    const ypr = rawQ ? yawPitchRoll(rawQ) : { yaw: 0, pitch: 0, roll: 0 };
    out.push({
      t: (k * 1000) / hz,
      pos: [d.xz[0], d.groundY + heightM, d.xz[1]],
      q: quatFromYawPitchRoll(heading + yawOffset, ypr.pitch, ypr.roll),
    });
  }
  return out;
}
