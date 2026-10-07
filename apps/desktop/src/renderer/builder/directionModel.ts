import type { CameraDirection } from '@aio/geo';
import type { DirectionFill, DirectionKey, Layer, LensModel, Vec3 } from '@aio/schema';

/*
 * Pure editing rules of "Align camera to map" (direction keyframes): which keyframe the playhead
 * is on, what the views show while a turn is not set yet, moving keyframes in time, and the
 * map gestures' geometry. The store (alignCamera.ts) and the views use these.
 */

type VideoLayer = Extract<Layer, { kind: 'video' }>;

/** The playhead is on a keyframe when it is this close (a frame at 25 fps is 40 ms). */
export const ON_KEY_MS = 20;
/** Keyframes stay at least this far apart when one is dragged in time. */
export const MIN_GAP_MS = 40;

/** Clip time (ms of video) of project time `nowMs`. */
export function clipTimeMs(clip: VideoLayer, nowMs: number): number {
  return nowMs - clip.flight.startUtcMs - clip.offsetMs;
}

/** Project time of clip time `clipMs`. */
export function projectTimeMs(clip: VideoLayer, clipMs: number): number {
  return clip.flight.startUtcMs + clip.offsetMs + clipMs;
}

/** Index of the keyframe at the playhead, or -1. */
export function keyAt(keys: readonly DirectionKey[], clipMs: number, tol = ON_KEY_MS): number {
  let best = -1;
  let gap = tol;
  keys.forEach((k, i) => {
    const d = Math.abs(k.t - clipMs);
    if (d <= gap) {
      best = i;
      gap = d;
    }
  });
  return best;
}

/**
 * The keyframe whose fill rules at the playhead: the last one at or before it, the first one
 * before the first keyframe; -1 without keyframes.
 */
export function segmentKey(keys: readonly DirectionKey[], clipMs: number): number {
  if (!keys.length) return -1;
  let i = 0;
  for (let k = 0; k < keys.length; k++) if ((keys[k]?.t ?? Infinity) <= clipMs + ON_KEY_MS) i = k;
  return i;
}

/** The keyframes with `key` added, replacing one at the same time (within `ON_KEY_MS`). */
export function withKey(keys: readonly DirectionKey[], key: DirectionKey): DirectionKey[] {
  const i = keyAt(keys, key.t);
  const out = i >= 0 ? keys.map((k, j) => (j === i ? key : k)) : [...keys, key];
  return out.sort((a, b) => a.t - b.t);
}

/** A keyframe from a direction at clip time `t`, keeping `like`'s fill and target. */
export function keyFrom(
  t: number,
  d: { yaw: number; pitch: number; roll: number },
  like?: Pick<DirectionKey, 'fill' | 'target'> | null,
): DirectionKey {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    t: Math.max(0, Math.round(t)),
    yaw: r(((d.yaw % 360) + 360) % 360),
    pitch: r(Math.min(90, Math.max(-90, d.pitch))),
    roll: r(((((d.roll + 180) % 360) + 360) % 360) - 180),
    fill: like?.fill ?? 'smooth',
    ...(like?.target ? { target: like.target } : {}),
  };
}

/**
 * What the views draw while aligning: the keyframes, with a turn that is not set yet at its time
 * (it takes the fill of the segment it falls in).
 */
export function previewKeys(
  keys: readonly DirectionKey[],
  trial: { t: number; dir: CameraDirection } | null,
): DirectionKey[] {
  if (!trial) return [...keys];
  const seg = keys[segmentKey(keys, trial.t)];
  const fill = seg && seg.fill !== 'lookAt' ? seg.fill : 'smooth';
  return withKey(keys, keyFrom(trial.t, trial.dir, { fill }));
}

/** Move keyframe `i` to clip time `t`, kept between its neighbours and inside the clip. */
export function moveKey(
  keys: readonly DirectionKey[],
  i: number,
  t: number,
  durationMs: number,
): DirectionKey[] {
  const k = keys[i];
  if (!k) return [...keys];
  const lo = i > 0 ? (keys[i - 1]?.t ?? 0) + MIN_GAP_MS : 0;
  const hi = i < keys.length - 1 ? (keys[i + 1]?.t ?? durationMs) - MIN_GAP_MS : durationMs;
  const nt = Math.round(Math.min(Math.max(t, lo), Math.max(lo, hi)));
  return keys.map((x, j) => (j === i ? { ...x, t: nt } : x));
}

/** Set the fill of keyframe `i` (a look-at needs a target; without one it stays as it was). */
export function setFill(
  keys: readonly DirectionKey[],
  i: number,
  fill: DirectionFill,
  target?: Vec3 | null,
): DirectionKey[] {
  return keys.map((k, j) => {
    if (j !== i) return k;
    if (fill === 'lookAt') {
      const tg = target ?? k.target;
      return tg ? { ...k, fill, target: tg } : k;
    }
    const rest: DirectionKey = { ...k, fill };
    delete rest.target;
    return rest;
  });
}

/** Vertical field of view of a lens, degrees (f-theta: its axis angle, capped). */
export function verticalFov(lens: LensModel): number {
  const h = (Math.min(lens.hfovDeg, 170) * Math.PI) / 360;
  return (2 * Math.atan(Math.tan(h) / lens.aspect) * 180) / Math.PI;
}

/**
 * Pitch that puts the top edge of the frame (its far edge on the ground) `dist` metres from the
 * point under a camera `height` metres up: the far-edge tilt handle on the map.
 */
export function pitchForFarEdge(height: number, dist: number, lens: LensModel): number {
  const below = (Math.atan2(Math.max(0.1, height), Math.max(0.1, dist)) * 180) / Math.PI;
  return Math.min(30, Math.max(-90, -below - verticalFov(lens) / 2));
}

/** Heading (degrees clockwise from grid north) from `a` to `b`, local frame. */
export function headingTo(a: Vec3, b: Vec3): number {
  return ((((Math.atan2(b[0] - a[0], -(b[2] - a[2])) * 180) / Math.PI) % 360) + 360) % 360;
}

/** Signed smallest difference `b - a` of two angles in degrees. */
export function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** "0:12.3" style clip time. */
export function formatClipMs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${String(m)}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
