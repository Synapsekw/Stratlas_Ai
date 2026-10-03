import type { PoseSample, Quat, Vec3 } from '@aio/schema';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  const [ax, ay, az, aw] = a;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    const r: Quat = [lerp(ax, bx, t), lerp(ay, by, t), lerp(az, bz, t), lerp(aw, bw, t)];
    const n = Math.hypot(...r);
    return [r[0] / n, r[1] / n, r[2] / n, r[3] / n];
  }
  const theta = Math.acos(cos);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
}

/**
 * Drone pose at time `tMs` (milliseconds since flight start). Samples must be sorted by `t`.
 * Position is interpolated linearly, orientation by slerp; times outside the log clamp to the ends.
 */
export function interpolatePose(samples: readonly PoseSample[], tMs: number): PoseSample {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) throw new Error('interpolatePose needs at least one pose sample');
  if (tMs <= first.t) return first;
  if (tMs >= last.t) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid]?.t ?? 0) <= tMs) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (!a || !b) return last;
  const f = (tMs - a.t) / (b.t - a.t);
  const pos: Vec3 = [
    lerp(a.pos[0], b.pos[0], f),
    lerp(a.pos[1], b.pos[1], f),
    lerp(a.pos[2], b.pos[2], f),
  ];
  return { t: tMs, pos, q: slerp(a.q, b.q, f) };
}
export { VideoWindow, type VideoWindowProps } from './VideoWindow';

/**
 * Registers video layer adapters with @aio/engine: flight path, drone marker and frustum, and the
 * projector that drapes the current frame on meshes and ground. Owner: stream S6. Phase 0: no-op.
 */
export function registerVideoAdapters(): void {
  /* implemented by stream S6 */
}
