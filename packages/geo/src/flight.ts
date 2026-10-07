import type { PoseSample, Quat, Vec3 } from '@aio/schema';
import { cameraQuatFromGimbal } from './camera';

/*
 * Flight log clean-up shared by the SRT importer and every reader of `aio.flight/1` files.
 *
 * Consumer DJI aircraft write one SRT block per video frame (~60 Hz) but their GPS fix changes only
 * a few times a second: the logged position holds still for a dozen frames, then jumps a metre.
 * Played back, the drone stutters along its path. Without gimbal angles the importer estimates the
 * camera heading from the track; the original estimate pointed north until the aircraft moved and
 * then snapped with every fix. These functions smooth both, never touching high-rate telemetry or
 * measured (gimbal, photogrammetry) orientations, and never the files on disk.
 */

const R2D = 180 / Math.PI;

/** A run of held positions longer than this many fix intervals is a hover, not a slow fix. */
const HOVER_FIXES = 4;
/** Above this share of samples repeating the previous position, the log is stair-stepped. */
const HELD_SHARE = 0.5;

const ZERO: Vec3 = [0, 0, 0];
const same = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mix = (a: Vec3, b: Vec3, wa: number, wb: number): Vec3 => [
  a[0] * wa + b[0] * wb,
  a[1] * wa + b[1] * wb,
  a[2] * wa + b[2] * wb,
];

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** Centripetal Catmull-Rom between p1 and p2 at u in [0, 1] (Barry and Goldman). */
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const k = (a: Vec3, b: Vec3) => Math.max(Math.sqrt(dist(a, b)), 1e-4);
  const t0 = 0;
  const t1 = t0 + k(p0, p1);
  const t2 = t1 + k(p1, p2);
  const t3 = t2 + k(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const a1 = mix(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
  const a2 = mix(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
  const a3 = mix(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
  const b1 = mix(a1, a2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
  const b2 = mix(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
  return mix(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
}

/**
 * Positions of a stair-stepped log (most samples repeat the previous position) as a smooth curve:
 * each change of the fix becomes a keyframe at the time it changed, a hover keeps its position
 * until one fix interval before the aircraft moves on, and the samples in between follow a
 * centripetal Catmull-Rom spline through the fixes (no overshoot loops). Null when the log is not
 * stair-stepped (high-rate telemetry is left alone) or has fewer than two fixes.
 */
export function smoothHeldPositions(t: readonly number[], pos: readonly Vec3[]): Vec3[] | null {
  const n = Math.min(t.length, pos.length);
  if (n < 3) return null;
  let held = 0;
  const kt: number[] = [];
  const kp: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const p = pos[i] ?? ZERO;
    if (i > 0 && same(p, pos[i - 1] ?? ZERO)) {
      held++;
      continue;
    }
    kt.push(t[i] ?? 0);
    kp.push(p);
  }
  if (held / (n - 1) <= HELD_SHARE || kt.length < 2) return null;
  const fix = median(kt.slice(1).map((v, i) => v - (kt[i] ?? 0)));
  // hovers: hold the position until one fix interval before the next one
  const keyT: number[] = [kt[0] ?? 0];
  const keyP: Vec3[] = [kp[0] ?? ZERO];
  for (let j = 1; j < kt.length; j++) {
    const gap = (kt[j] ?? 0) - (kt[j - 1] ?? 0);
    if (fix > 0 && gap > HOVER_FIXES * fix) {
      keyT.push((kt[j] ?? 0) - fix);
      keyP.push(kp[j - 1] ?? ZERO);
    }
    keyT.push(kt[j] ?? 0);
    keyP.push(kp[j] ?? ZERO);
  }
  const out: Vec3[] = [];
  let j = 0;
  const last = keyT.length - 1;
  for (let i = 0; i < n; i++) {
    const ti = t[i] ?? 0;
    while (j < last && (keyT[j + 1] ?? 0) <= ti) j++;
    const p1 = keyP[j] ?? ZERO;
    if (j >= last) {
      out.push([...p1]);
      continue;
    }
    const p2 = keyP[j + 1] ?? ZERO;
    if (same(p1, p2)) {
      out.push([...p1]);
      continue;
    }
    const prev = keyP[j - 1];
    const next = keyP[j + 2];
    // at the ends and next to hovers, mirror the segment so the curve leaves straight
    const p0 = prev && !same(prev, p1) ? prev : mix(p1, p2, 2, -1);
    const p3 = next && !same(next, p2) ? next : mix(p2, p1, 2, -1);
    const u = (ti - (keyT[j] ?? 0)) / ((keyT[j + 1] ?? 0) - (keyT[j] ?? 0));
    out.push(catmullRom(p0, p1, p2, p3, Math.min(1, Math.max(0, u))));
  }
  return out;
}

export interface HeadingOptions {
  /** Track window around each sample, ms. Default 1000. */
  windowMs?: number;
  /** Below this horizontal speed (m/s) the aircraft hovers and keeps its last heading. Default 0.5. */
  minSpeedMps?: number;
  /** Circular moving average over this span, ms. Default 1500. */
  smoothMs?: number;
}

/**
 * Camera heading (degrees clockwise from grid north) estimated from the horizontal track: the
 * direction of travel over a short window, held through hovers, the samples before the first
 * movement backfilled with the first heading (never a default north), then a circular moving
 * average so the view turns instead of snapping. Null when the aircraft never moves.
 */
export function estimateHeadings(
  t: readonly number[],
  pos: readonly Vec3[],
  o: HeadingOptions = {},
): number[] | null {
  const n = Math.min(t.length, pos.length);
  const half = (o.windowMs ?? 1000) / 2;
  const minSpeed = o.minSpeedMps ?? 0.5;
  const raw: (number | null)[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[i] ?? 0;
    while ((t[lo] ?? 0) < ti - half) lo++;
    while (hi + 1 < n && (t[hi + 1] ?? 0) <= ti + half) hi++;
    const a = pos[lo] ?? ZERO;
    const b = pos[hi] ?? ZERO;
    const de = b[0] - a[0];
    const dn = -(b[2] - a[2]);
    const dt = ((t[hi] ?? 0) - (t[lo] ?? 0)) / 1000;
    raw.push(dt > 0 && Math.hypot(de, dn) / dt >= minSpeed ? Math.atan2(de, dn) : null);
  }
  const first = raw.find((h): h is number => h !== null);
  if (first === undefined) return null;
  let last = first;
  const filled = raw.map((h) => (h === null ? last : (last = h)));
  // circular moving average (prefix sums of sine and cosine)
  const sx = [0];
  const cx = [0];
  for (let i = 0; i < n; i++) {
    sx.push((sx[i] ?? 0) + Math.sin(filled[i] ?? 0));
    cx.push((cx[i] ?? 0) + Math.cos(filled[i] ?? 0));
  }
  const sHalf = (o.smoothMs ?? 1500) / 2;
  const out: number[] = [];
  lo = 0;
  hi = 0;
  for (let i = 0; i < n; i++) {
    const ti = t[i] ?? 0;
    while ((t[lo] ?? 0) < ti - sHalf) lo++;
    while (hi + 1 < n && (t[hi + 1] ?? 0) <= ti + sHalf) hi++;
    const s = (sx[hi + 1] ?? 0) - (sx[lo] ?? 0);
    const c = (cx[hi + 1] ?? 0) - (cx[lo] ?? 0);
    const h = Math.hypot(s, c) > 1e-9 ? Math.atan2(s, c) : (filled[i] ?? 0);
    out.push((((h * R2D) % 360) + 360) % 360);
  }
  return out;
}

/**
 * Heading of the track around each sample as the first importer computed it (1 s window, 0.3 m,
 * north until the aircraft moved). Only used to recognise files that importer wrote.
 */
function legacyTrackHeadings(pos: readonly Vec3[], t: readonly number[]): number[] {
  const out: number[] = [];
  let last = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < pos.length; i++) {
    const ti = t[i] ?? 0;
    while ((t[lo] ?? 0) < ti - 1000) lo++;
    while (hi + 1 < pos.length && (t[hi + 1] ?? 0) <= ti + 1000) hi++;
    const a = pos[lo] ?? [0, 0, 0];
    const b = pos[hi] ?? [0, 0, 0];
    const de = b[0] - a[0];
    const dn = -(b[2] - a[2]);
    if (Math.hypot(de, dn) > 0.3) last = Math.atan2(de, dn) * R2D;
    out.push(last);
  }
  return out;
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

/** Heading (clockwise from grid north), pitch (up positive) and image-right tilt of a camera. */
function angles(q: Quat): { heading: number; pitch: number; tilt: number } {
  const f = rotate(q, [0, 0, -1]);
  const r = rotate(q, [1, 0, 0]);
  return {
    heading: (Math.atan2(f[0], -f[2]) * R2D + 360) % 360,
    pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) * R2D,
    tilt: r[1],
  };
}

const angleGap = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/**
 * The camera orientation looks estimated rather than measured: no gimbal angles, a level image
 * (no roll) and one fixed pitch throughout. True for every SRT import without gimbal angles.
 */
export function looksEstimated(samples: readonly PoseSample[]): boolean {
  const first = samples[0];
  if (!first || samples.some((s) => s.gimbal)) return false;
  const pitch = angles(first.q).pitch;
  return samples.every((s) => {
    const a = angles(s.q);
    return Math.abs(a.tilt) < 2e-3 && Math.abs(a.pitch - pitch) < 0.05;
  });
}

/** Written by the first SRT importer: estimated, and the heading is its raw track estimate. */
function legacyEstimated(samples: readonly PoseSample[]): boolean {
  if (samples.length < 2 || !looksEstimated(samples)) return false;
  const legacy = legacyTrackHeadings(
    samples.map((s) => s.pos),
    samples.map((s) => s.t),
  );
  let off = 0;
  samples.forEach((s, i) => {
    if (angleGap(angles(s.q).heading, legacy[i] ?? 0) > 0.5) off++;
  });
  return off <= samples.length * 0.02;
}

export interface NormalisedFlight {
  samples: PoseSample[];
  /** Positions were stair-stepped and are now interpolated between the fixes. */
  positions: boolean;
  /** The estimated camera heading was re-estimated (backfilled and smoothed). */
  heading: boolean;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Clean up a flight log as it loads (never written back): stair-stepped positions are smoothed
 * between the GPS fixes, and a heading estimated by the first SRT importer is estimated again
 * (backfilled before the first movement, held through hovers, smoothed). Measured orientations
 * (gimbal angles, photogrammetry poses) and high-rate positions come back unchanged. Returns the
 * input array itself when nothing changes. Idempotent: a log cleaned at import is left alone.
 */
export function normaliseFlight(samples: readonly PoseSample[]): NormalisedFlight {
  const t = samples.map((s) => s.t);
  const raw = samples.map((s) => s.pos);
  const pos = smoothHeldPositions(t, raw);
  const headings = legacyEstimated(samples) ? estimateHeadings(t, pos ?? raw) : null;
  if (!pos && !headings)
    return { samples: samples as PoseSample[], positions: false, heading: false };
  const pitch = samples[0] ? angles(samples[0].q).pitch : 0;
  const out = samples.map((s, i): PoseSample => {
    const p = pos?.[i];
    const h = headings?.[i];
    const q = h === undefined ? s.q : cameraQuatFromGimbal(h, pitch, 0);
    return {
      ...s,
      pos: p ? [round(p[0], 4), round(p[1], 4), round(p[2], 4)] : s.pos,
      q: h === undefined ? q : [round(q[0], 7), round(q[1], 7), round(q[2], 7), round(q[3], 7)],
    };
  });
  return { samples: out, positions: pos !== null, heading: headings !== null };
}

/** `normaliseFlight` for readers that only want the samples. */
export function normaliseSamples(samples: readonly PoseSample[]): PoseSample[] {
  return normaliseFlight(samples).samples;
}
