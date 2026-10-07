import type {
  CameraOrientation,
  DirectionKey,
  Layer,
  OrientationFile,
  PoseSample,
  Quat,
  Vec3,
} from '@aio/schema';
import { cameraQuatFromGimbal } from './camera';
import { estimateHeadings } from './flight';

/*
 * The camera of a video clip at a moment: one rule for every reader (3D rig, map, annotate, AI
 * tools, the direction tool itself).
 *
 * - Position: the flight log (normalised), interpolated, plus the clip's `positionOffsetM`.
 * - Orientation: the clip's direction keyframes when it has at least one (absolute: the log and
 *   the calibration bias `orientation` do not apply); otherwise the logged orientation (gimbal
 *   angles, else the importer's estimate) turned by the calibration bias, as before.
 */

const R2D = 180 / Math.PI;
/** Look-at keyframes blend into and out of the aim over this long (shorter segments: half). */
export const LOOK_AT_BLEND_MS = 500;

type VideoLayer = Extract<Layer, { kind: 'video' }>;

/** Heading, pitch and roll of a camera in the project grid frame (degrees, as `DirectionKey`). */
export interface CameraDirection {
  /** Clockwise from grid north, [0, 360). */
  yaw: number;
  /** Up positive, [-90, 90]. */
  pitch: number;
  /** Drops the image's right side, (-180, 180]. */
  roll: number;
}

/** What it takes to place a clip's camera on its flight log. */
export interface ClipCamera {
  /** Flight log time (ms since the log's `startUtcMs`) of video time 0. */
  videoStartMs: number;
  /** Calibration bias (camera frame, after the logged orientation); ignored with keyframes. */
  orientation?: CameraOrientation | null | undefined;
  /** Calibration position offset, local frame metres. */
  positionOffsetM?: Vec3 | null | undefined;
  /** Direction keyframes (clip time); one or more replace the logged orientation. */
  directionKeys?: readonly DirectionKey[] | null | undefined;
}

/**
 * The clip camera of a video layer with its direction keyframes (`clipKeys` of the project's
 * `orientation.json`, or an unsaved draft; none: the logged direction). `flightStartUtcMs` is the
 * start of the flight file the samples come from (the layer's own `flight.startUtcMs` unless the
 * file says otherwise).
 */
export function clipCamera(
  layer: Pick<VideoLayer, 'flight' | 'offsetMs' | 'orientation' | 'positionOffsetM'>,
  keys?: readonly DirectionKey[] | null,
  flightStartUtcMs: number = layer.flight.startUtcMs,
): ClipCamera {
  return {
    videoStartMs: layer.flight.startUtcMs + layer.offsetMs - flightStartUtcMs,
    orientation: layer.orientation,
    positionOffsetM: layer.positionOffsetM,
    directionKeys: keys ?? null,
  };
}

/** A clip's saved direction keyframes in `orientation.json`, or null. */
export function clipKeys(
  file: OrientationFile | null | undefined,
  layerId: string,
): readonly DirectionKey[] | null {
  const keys = file?.clips[layerId]?.keys;
  return keys?.length ? keys : null;
}

// ------------------------------------------------------------------ quaternions

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function normalise(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Shortest-arc spherical interpolation. */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
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
  if (cos > 0.9995)
    return normalise([
      ax + (bx - ax) * t,
      ay + (by - ay) * t,
      az + (bz - az) * t,
      aw + (bw - aw) * t,
    ]);
  const th = Math.acos(cos);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
}

/** The calibration bias as a quaternion: Ry(yaw) Rx(pitch) Rz(roll), camera frame. */
function biasQuat(o: CameraOrientation): Quat {
  const h = (d: number) => (d * Math.PI) / 360;
  const y: Quat = [0, Math.sin(h(o.yawDeg)), 0, Math.cos(h(o.yawDeg))];
  const x: Quat = [Math.sin(h(o.pitchDeg)), 0, 0, Math.cos(h(o.pitchDeg))];
  const z: Quat = [0, 0, Math.sin(h(o.rollDeg)), Math.cos(h(o.rollDeg))];
  return quatMul(quatMul(y, x), z);
}

/** A logged orientation turned by a calibration bias (`orientCamera` in @aio/video). */
export function biasedQuat(q: Quat, o: CameraOrientation | null | undefined): Quat {
  if (!o || (o.yawDeg === 0 && o.pitchDeg === 0 && o.rollDeg === 0)) return q;
  return normalise(quatMul(q, biasQuat(o)));
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;

/**
 * Heading, pitch and roll of a camera quaternion (three.js camera axes): the inverse of
 * `cameraQuatFromGimbal`. Straight down, the heading is that of the image top.
 */
export function directionFromQuat(q: Quat): CameraDirection {
  const [x, y, z, w] = normalise(q);
  // Euler 'YXZ' of q = Ry(-yaw) Rx(pitch) Rz(-roll)
  const m11 = 1 - 2 * (y * y + z * z);
  const m13 = 2 * (x * z + y * w);
  const m21 = 2 * (x * y + z * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m31 = 2 * (x * z - y * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const pitch = Math.asin(Math.min(1, Math.max(-1, -m23)));
  let ey: number;
  let ez: number;
  if (Math.abs(m23) < 0.9999999) {
    ey = Math.atan2(m13, m33);
    ez = Math.atan2(m21, m22);
  } else {
    ey = Math.atan2(-m31, m11);
    ez = 0;
  }
  const roll = wrap180(-ez * R2D);
  return { yaw: wrap360(-ey * R2D), pitch: pitch * R2D, roll: roll === -180 ? 180 : roll };
}

/** Heading and pitch (degrees) of the line from `from` to `to`, local frame. */
export function aimAt(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const h = Math.hypot(dx, dz);
  return {
    yaw: h > 1e-9 ? wrap360(Math.atan2(dx, -dz) * R2D) : 0,
    pitch: Math.atan2(dy, h) * R2D,
  };
}

const keyQuat = (k: { yaw: number; pitch: number; roll: number }) =>
  cameraQuatFromGimbal(k.yaw, k.pitch, k.roll);

const smoothstep = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

// ------------------------------------------------------------------ keyframe evaluation

/** What the keyframe fills need from the flight, at clip time (ms). */
export interface DirectionContext {
  /** Camera position (calibrated), local frame. */
  positionAt(clipMs: number): Vec3;
  /** Smoothed track heading (degrees clockwise from grid north), or null if it never moves. */
  trackHeadingAt(clipMs: number): number | null;
}

function aimQuat(key: DirectionKey, clipMs: number, ctx: DirectionContext): Quat | null {
  if (!key.target) return null;
  const a = aimAt(ctx.positionAt(clipMs), key.target);
  return cameraQuatFromGimbal(a.yaw, a.pitch, 0);
}

/** `key`'s direction carried to `clipMs` by its own fill (before the first, after the last). */
function hold(key: DirectionKey, clipMs: number, ctx: DirectionContext): Quat {
  const own = keyQuat(key);
  if (key.fill === 'track') {
    const h0 = ctx.trackHeadingAt(key.t);
    const h = ctx.trackHeadingAt(clipMs);
    if (h0 !== null && h !== null) return keyQuat({ ...key, yaw: h + wrap180(key.yaw - h0) });
  }
  if (key.fill === 'lookAt') {
    const aim = aimQuat(key, clipMs, ctx);
    if (aim) {
      const d = Math.abs(clipMs - key.t);
      return d < LOOK_AT_BLEND_MS ? slerpQuat(own, aim, smoothstep(d / LOOK_AT_BLEND_MS)) : aim;
    }
  }
  return own;
}

/** Between keyframe `a` and the next one `b`, by `a`'s fill. */
function between(a: DirectionKey, b: DirectionKey, clipMs: number, ctx: DirectionContext): Quat {
  const span = b.t - a.t;
  const u = span > 0 ? (clipMs - a.t) / span : 0;
  if (a.fill === 'track') {
    const ha = ctx.trackHeadingAt(a.t);
    const hb = ctx.trackHeadingAt(b.t);
    const h = ctx.trackHeadingAt(clipMs);
    if (ha !== null && hb !== null && h !== null) {
      const offA = wrap180(a.yaw - ha);
      const offB = wrap180(b.yaw - hb);
      const e = smoothstep(u);
      return cameraQuatFromGimbal(
        h + offA + wrap180(offB - offA) * u,
        a.pitch + (b.pitch - a.pitch) * e,
        a.roll + wrap180(b.roll - a.roll) * e,
      );
    }
  }
  if (a.fill === 'lookAt') {
    const aim = aimQuat(a, clipMs, ctx);
    if (aim) {
      const blend = Math.min(LOOK_AT_BLEND_MS, span / 2);
      const fromA = clipMs - a.t;
      const toB = b.t - clipMs;
      if (blend > 0 && fromA < blend) return slerpQuat(keyQuat(a), aim, smoothstep(fromA / blend));
      if (blend > 0 && toB < blend) return slerpQuat(aim, keyQuat(b), smoothstep(1 - toB / blend));
      return aim;
    }
  }
  // smooth, and any fill this build does not know
  return slerpQuat(keyQuat(a), keyQuat(b), Math.min(1, Math.max(0, u)));
}

/**
 * Camera orientation at clip time `clipMs` from direction keyframes (sorted by `t`), or null
 * without keyframes. Before the first keyframe and after the last, that keyframe's direction
 * holds by its own fill (a `track` keyframe keeps its offset from the track, a `lookAt` one keeps
 * aiming at its target).
 */
export function directionAt(
  keys: readonly DirectionKey[],
  clipMs: number,
  ctx: DirectionContext,
): Quat | null {
  const n = keys.length;
  const first = keys[0];
  const last = keys[n - 1];
  if (!first || !last) return null;
  if (clipMs <= first.t) return hold(first, clipMs, ctx);
  if (clipMs >= last.t) return hold(last, clipMs, ctx);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((keys[mid]?.t ?? 0) <= clipMs) lo = mid;
    else hi = mid;
  }
  const a = keys[lo] ?? first;
  const b = keys[hi] ?? last;
  return between(a, b, clipMs, ctx);
}

// ------------------------------------------------------------------ flight lookups

/** Position and orientation of the log at flight time `t`: linear position, slerped rotation. */
export function logPoseAt(samples: readonly PoseSample[], t: number): { pos: Vec3; q: Quat } {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return { pos: [0, 0, 0], q: [0, 0, 0, 1] };
  if (t <= first.t) return { pos: first.pos, q: first.q };
  if (t >= last.t) return { pos: last.pos, q: last.q };
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid]?.t ?? 0) <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo] ?? first;
  const b = samples[hi] ?? last;
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return {
    pos: [
      a.pos[0] + (b.pos[0] - a.pos[0]) * k,
      a.pos[1] + (b.pos[1] - a.pos[1]) * k,
      a.pos[2] + (b.pos[2] - a.pos[2]) * k,
    ],
    q: slerpQuat(a.q, b.q, k),
  };
}

const headingCache = new WeakMap<readonly PoseSample[], number[] | null>();

/** Smoothed track heading of a log at flight time `t`, or null when the aircraft never moves. */
export function trackHeadingAt(samples: readonly PoseSample[], t: number): number | null {
  let h = headingCache.get(samples);
  if (h === undefined) {
    h = estimateHeadings(
      samples.map((s) => s.t),
      samples.map((s) => s.pos),
    );
    headingCache.set(samples, h);
  }
  if (!h?.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;
  if (t <= first.t) return h[0] ?? null;
  if (t >= last.t) return h[h.length - 1] ?? null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid]?.t ?? 0) <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo] ?? first;
  const b = samples[hi] ?? last;
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const ha = h[lo] ?? 0;
  return wrap360(ha + wrap180((h[hi] ?? ha) - ha) * k);
}

/** The direction context of a clip on its flight log. */
export function directionContext(
  samples: readonly PoseSample[],
  clip: Pick<ClipCamera, 'videoStartMs' | 'positionOffsetM'>,
): DirectionContext {
  const off = clip.positionOffsetM;
  return {
    positionAt: (clipMs) => {
      const p = logPoseAt(samples, clip.videoStartMs + clipMs).pos;
      return off ? [p[0] + off[0], p[1] + off[1], p[2] + off[2]] : p;
    },
    trackHeadingAt: (clipMs) => trackHeadingAt(samples, clip.videoStartMs + clipMs),
  };
}

/** A clip's camera at one moment. */
export interface ClipPose {
  /** Calibrated position, local frame. */
  pos: Vec3;
  /** Camera orientation (three.js camera axes) in use. */
  q: Quat;
  /** Where the orientation comes from: keyframes, or the log (gimbal or estimate, with bias). */
  source: 'keys' | 'log';
  /** The log's own pose there (before calibration), for calibration pairs. */
  log: { pos: Vec3; q: Quat };
}

/**
 * The camera of a clip at flight log time `flightMs` (ms since the log's start): position from
 * the log plus the position offset; orientation from the direction keyframes when the clip has
 * any, else the logged orientation turned by the calibration bias.
 */
export function clipPoseAt(
  samples: readonly PoseSample[],
  flightMs: number,
  clip: ClipCamera,
): ClipPose {
  const log = logPoseAt(samples, flightMs);
  const off = clip.positionOffsetM;
  const pos: Vec3 = off ? [log.pos[0] + off[0], log.pos[1] + off[1], log.pos[2] + off[2]] : log.pos;
  const keys = clip.directionKeys;
  if (keys?.length) {
    const q = directionAt(keys, flightMs - clip.videoStartMs, directionContext(samples, clip));
    if (q) return { pos, q, source: 'keys', log };
  }
  return { pos, q: biasedQuat(log.q, clip.orientation), source: 'log', log };
}
