import type { FrameGeom, Sighting, Vec2 } from '@aio/schema';

/**
 * Video sightings store `t` in **video seconds** (data-conventions section 3: video time `v`),
 * so a track survives a change of the layer's `offsetMs`.
 */
export type Keyframe = Extract<Sighting, { on: 'video' }>['track'][number];
export type VideoSighting = Extract<Sighting, { on: 'video' }>;

/** One frame at 29.97 fps, rounded up: keyframes closer than this are the same frame. */
export const FRAME_EPS_S = 1 / 29;

interface ClipTiming {
  flight: { startUtcMs: number };
  offsetMs: number;
}

/** Project clock (UTC ms) to video seconds for a video layer. */
export function videoTimeS(layer: ClipTiming, nowMs: number): number {
  return (nowMs - layer.flight.startUtcMs - layer.offsetMs) / 1000;
}

/** Video seconds to project clock (UTC ms). */
export function projectMsFromVideo(layer: ClipTiming, tS: number): number {
  return layer.flight.startUtcMs + layer.offsetMs + tS * 1000;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

function blend(a: FrameGeom, b: FrameGeom, f: number): FrameGeom {
  if (a.type === 'box' && b.type === 'box') {
    return {
      type: 'box',
      x: lerp(a.x, b.x, f),
      y: lerp(a.y, b.y, f),
      w: lerp(a.w, b.w, f),
      h: lerp(a.h, b.h, f),
    };
  }
  if (a.type === 'polygon' && b.type === 'polygon' && a.points.length === b.points.length) {
    return {
      type: 'polygon',
      points: a.points.map((p, i): Vec2 => {
        const q = b.points[i] ?? p;
        return [lerp(p[0], q[0], f), lerp(p[1], q[1], f)];
      }),
    };
  }
  return a;
}

/**
 * The tracked shape at video time `t`: exact on a keyframe, linear between keyframes, nothing
 * before the first or after the last keyframe (one frame of tolerance).
 */
export function interpolateTrack(
  track: readonly Keyframe[],
  t: number,
  eps = FRAME_EPS_S,
): { geom: FrameGeom; key: boolean } | null {
  const first = track[0];
  const last = track[track.length - 1];
  if (!first || !last) return null;
  if (t < first.t - eps || t > last.t + eps) return null;
  for (const k of track) if (Math.abs(k.t - t) <= eps / 2) return { geom: k.geom, key: true };
  if (t <= first.t) return { geom: first.geom, key: false };
  if (t >= last.t) return { geom: last.geom, key: false };
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    if (a && b && t >= a.t && t <= b.t) {
      return { geom: blend(a.geom, b.geom, (t - a.t) / (b.t - a.t)), key: false };
    }
  }
  return null;
}

/** The shape to start a new keyframe from: interpolated inside the track, held at its ends. */
export function trackGeomAt(track: readonly Keyframe[], t: number): FrameGeom | null {
  const first = track[0];
  const last = track[track.length - 1];
  if (!first || !last) return null;
  if (t <= first.t) return first.geom;
  if (t >= last.t) return last.geom;
  return interpolateTrack(track, t)?.geom ?? null;
}

/** Add a keyframe, or replace the one within a frame of `t`. Keeps time order. */
export function setKeyframe(
  track: readonly Keyframe[],
  t: number,
  geom: FrameGeom,
  eps = FRAME_EPS_S,
): Keyframe[] {
  const time = Math.max(0, t);
  const existing = track.findIndex((k) => Math.abs(k.t - time) <= eps / 2);
  if (existing >= 0) {
    return track.map((k, i) => (i === existing ? { t: k.t, geom } : k));
  }
  return [...track, { t: time, geom }].sort((a, b) => a.t - b.t);
}

export function removeKeyframe(
  track: readonly Keyframe[],
  t: number,
  eps = FRAME_EPS_S,
): Keyframe[] {
  return track.filter((k) => Math.abs(k.t - t) > eps / 2);
}

/** Mark in or out of a time-range event; the other end follows so that in <= out. */
export function markRange(
  range: readonly [number, number] | undefined,
  end: 'in' | 'out',
  t: number,
): [number, number] {
  const time = Math.max(0, t);
  const [a, b] = range ?? [time, time];
  if (end === 'in') return [time, Math.max(time, b)];
  return [Math.min(a, time), time];
}
