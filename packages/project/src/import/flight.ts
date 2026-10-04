import { z } from 'zod';
import { FlightHeights, LensModel, PoseSample, Quat, Vec3 } from '@aio/schema';
import { mapPoint, mapQuat, type FrameMap } from './frames';
import { angleDeg, quatNormalize, quatRotate, quatSlerp, round, roundVec, sub } from './math';

/** `aio.flight/1` pose file (data-conventions section 3). */
export const AioFlight = z.object({
  schema: z.literal('aio.flight/1'),
  name: z.string().optional(),
  startUtcMs: z.number().int(),
  lens: LensModel,
  samples: z.array(PoseSample).min(1),
  /** The altitude rule of the sample heights (data-conventions section 3a); absent in older files. */
  heights: FlightHeights.optional(),
});
export type AioFlight = z.infer<typeof AioFlight>;

/** Point of interest logged by the Elios 3 and placed on the model by the kit. */
export const KitPoi = z.object({
  name: z.string(),
  image: z.string().nullable().optional(),
  t: z.number(),
  crit: z.number().optional(),
  comment: z.string().optional(),
  target: Vec3,
  dist: z.number().optional(),
  dist_log: z.number().optional(),
  cam: Vec3,
  dir: Vec3,
});
export type KitPoi = z.infer<typeof KitPoi>;

/** Flight JSON of the Asset Inspection Kit (`data/flightNNN.js`), tank model frame. */
export const KitFlight = z.object({
  id: z.string(),
  name: z.string(),
  video_offset: z.number(),
  duration_s: z.number(),
  segments: z.array(z.string()),
  segment_s: z.number().positive(),
  /** Seconds on the concatenated video timeline (negative before the video starts). */
  t: z.array(z.number()),
  /** Camera position. */
  pos: z.array(Vec3),
  /** three.js camera quaternion (looks down -Z), gimbal folded in. */
  q: z.array(Quat),
  /** Drone body quaternion. */
  qd: z.array(Quat),
  servo: z.array(z.number()),
  pois: z.array(KitPoi),
  fov_h_deg: z.number(),
  lens: z.string(),
  align: z.record(z.string(), z.unknown()).optional(),
});
export type KitFlight = z.infer<typeof KitFlight>;

/**
 * Convert a kit flight into an `aio.flight/1` document in the local frame.
 * Sample time is milliseconds since the first sample; `t0` (seconds, source video clock) is
 * returned so clips can be placed with {@link clipOffsetMs}.
 */
export function convertKitFlight(
  f: KitFlight,
  frame: FrameMap,
  startUtcMs: number,
  aspect: number,
): { doc: AioFlight; t0: number } {
  const n = Math.min(f.t.length, f.pos.length, f.q.length);
  if (n === 0) throw new Error(`Flight ${f.id} has no samples`);
  const t0 = f.t[0] ?? 0;
  const samples: PoseSample[] = [];
  let last = -1;
  for (let i = 0; i < n; i++) {
    const t = f.t[i];
    const p = f.pos[i];
    const q = f.q[i];
    if (t === undefined || p === undefined || q === undefined) continue;
    const ms = Math.round((t - t0) * 1000);
    if (ms <= last) continue;
    last = ms;
    samples.push({
      t: ms,
      pos: roundVec(mapPoint(frame, p), 4),
      q: roundVec(quatNormalize(mapQuat(frame, q)), 6),
    });
  }
  const lens: LensModel =
    f.lens === 'ftheta'
      ? { model: 'ftheta', hfovDeg: f.fov_h_deg, aspect: round(aspect, 4) }
      : { model: 'pinhole', hfovDeg: f.fov_h_deg, aspect: round(aspect, 4) };
  return { doc: { schema: 'aio.flight/1', name: f.name, startUtcMs, lens, samples }, t0 };
}

/**
 * Video layer `offsetMs` for clip `k` of a video cut into `segmentS` second clips, when the
 * flight file starts at source time `t0` (seconds on the concatenated video clock).
 * Project time of clip time v: startUtcMs + offsetMs + v * 1000 = startUtcMs + (k * segmentS + v - t0) * 1000.
 */
export function clipOffsetMs(k: number, segmentS: number, t0: number): number {
  return Math.round((k * segmentS - t0) * 1000);
}

/** Interpolated pose at flight time `tMs`. */
export function poseAt(doc: AioFlight, tMs: number): { pos: Vec3; q: Quat } {
  const s = doc.samples;
  const first = s[0];
  if (!first) throw new Error('Flight has no samples');
  let lo = 0;
  let hi = s.length - 1;
  const lastS = s[hi] ?? first;
  if (tMs <= first.t) return { pos: first.pos, q: first.q };
  if (tMs >= lastS.t) return { pos: lastS.pos, q: lastS.q };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((s[mid]?.t ?? 0) <= tMs) lo = mid;
    else hi = mid;
  }
  const a = s[lo] ?? first;
  const b = s[hi] ?? first;
  const u = (tMs - a.t) / (b.t - a.t);
  return {
    pos: [
      a.pos[0] + (b.pos[0] - a.pos[0]) * u,
      a.pos[1] + (b.pos[1] - a.pos[1]) * u,
      a.pos[2] + (b.pos[2] - a.pos[2]) * u,
    ],
    q: quatSlerp(a.q, b.q, u),
  };
}

/**
 * The kit attaches a POI to the first log sample at or after the POI time (numpy searchsorted).
 * Returns that sample's source time (seconds), so poses match the kit exactly.
 */
export function logSampleTime(t: readonly number[], tp: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((t[mid] ?? Infinity) < tp) lo = mid + 1;
    else hi = mid;
  }
  return t[Math.min(lo, t.length - 1)] ?? tp;
}

/** Camera viewing direction of a three.js camera quaternion. */
export function cameraForward(q: Quat): Vec3 {
  return quatRotate(q, [0, 0, -1]);
}

/** Angle (deg) between the camera's view direction at `tMs` and the direction to `target`. */
export function aimErrorDeg(doc: AioFlight, tMs: number, target: Vec3): number {
  const { pos, q } = poseAt(doc, tMs);
  return angleDeg(cameraForward(q), sub(target, pos));
}
