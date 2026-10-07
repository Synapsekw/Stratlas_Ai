import type { CameraOrientation, PoseSample, Quat, Vec3 } from '@aio/schema';
import { orientCamera } from './orientation';
import { interpolatePose } from './pose';
import { cameraAngles } from './telemetry';

/**
 * The drone telemetry trace of one clip, without three.js: the clip's stretch of the flight as a
 * polyline in the local frame (calibrated: `positionOffsetM` added), the distance flown along it,
 * distance ticks and the HUD readout at the playhead.
 */
export interface TraceProfile {
  /** Flight time (ms since the flight start) of each vertex, ascending. */
  t: Float64Array;
  /** Vertex positions, xyz per vertex, local frame. */
  pos: Float64Array;
  /** Distance flown (m) from the clip start to each vertex. */
  dist: Float64Array;
  /** Vertex count. */
  n: number;
  /** Distance of the whole clip, metres. */
  length: number;
}

/** Positions are averaged over this many samples either side for the distance (GNSS jitter). */
const SMOOTH = 2;

/**
 * The clip's path from flight time `fromMs` to `toMs`: the interpolated pose at both ends and
 * every sample between, shifted by `offset`. The distance runs along a lightly smoothed copy (a
 * centred moving average that keeps the end points and straight runs exact), so a hovering
 * drone's position noise does not count as flight.
 */
export function traceProfile(
  samples: readonly PoseSample[],
  fromMs: number,
  toMs: number,
  offset: Vec3 | null = null,
): TraceProfile {
  const pts: { t: number; p: Vec3 }[] = [];
  const a = Math.min(fromMs, toMs);
  const b = Math.max(fromMs, toMs);
  pts.push({ t: a, p: interpolatePose(samples, a).pos });
  for (const s of samples) if (s.t > a && s.t < b) pts.push({ t: s.t, p: s.pos });
  if (b > a) pts.push({ t: b, p: interpolatePose(samples, b).pos });
  const n = pts.length;
  const t = new Float64Array(n);
  const pos = new Float64Array(n * 3);
  const [ox, oy, oz] = offset ?? [0, 0, 0];
  pts.forEach((v, i) => {
    t[i] = v.t;
    pos[i * 3] = v.p[0] + ox;
    pos[i * 3 + 1] = v.p[1] + oy;
    pos[i * 3 + 2] = v.p[2] + oz;
  });
  const smooth = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = Math.min(SMOOTH, i, n - 1 - i);
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (let j = i - r; j <= i + r; j++) sum += pos[j * 3 + k] ?? 0;
      smooth[i * 3 + k] = sum / (2 * r + 1);
    }
  }
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = (smooth[i * 3] ?? 0) - (smooth[i * 3 - 3] ?? 0);
    const dy = (smooth[i * 3 + 1] ?? 0) - (smooth[i * 3 - 2] ?? 0);
    const dz = (smooth[i * 3 + 2] ?? 0) - (smooth[i * 3 - 1] ?? 0);
    dist[i] = (dist[i - 1] ?? 0) + Math.hypot(dx, dy, dz);
  }
  return { t, pos, dist, n, length: dist[n - 1] ?? 0 };
}

/** Index of the last vertex at or before `tMs` (0 before the start). */
export function vertexBefore(p: TraceProfile, tMs: number): number {
  let lo = 0;
  let hi = p.n - 1;
  if (tMs >= (p.t[hi] ?? 0)) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((p.t[mid] ?? 0) <= tMs) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Distance flown from the clip start at flight time `tMs` (clamped to the clip). */
export function distanceAt(p: TraceProfile, tMs: number): number {
  const i = vertexBefore(p, tMs);
  const j = Math.min(p.n - 1, i + 1);
  const ta = p.t[i] ?? 0;
  const tb = p.t[j] ?? 0;
  const f = tb > ta ? Math.min(1, Math.max(0, (tMs - ta) / (tb - ta))) : 0;
  const da = p.dist[i] ?? 0;
  return da + ((p.dist[j] ?? 0) - da) * f;
}

/** The point and the horizontal direction of travel at distance `d` along the path. */
export function pointAtDistance(p: TraceProfile, d: number): { pos: Vec3; dir: [number, number] } {
  let lo = 0;
  let hi = p.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((p.dist[mid] ?? 0) <= d) lo = mid;
    else hi = mid;
  }
  const da = p.dist[lo] ?? 0;
  const db = p.dist[hi] ?? 0;
  const f = db > da ? Math.min(1, Math.max(0, (d - da) / (db - da))) : 0;
  const at = (k: number) => {
    const a = p.pos[lo * 3 + k] ?? 0;
    return a + ((p.pos[hi * 3 + k] ?? 0) - a) * f;
  };
  // direction over a stretch around the point, so a jittery sample does not turn the tick
  const span = (k: number) =>
    (p.pos[Math.min(p.n - 1, hi + 2) * 3 + k] ?? 0) - (p.pos[Math.max(0, lo - 2) * 3 + k] ?? 0);
  const dx = span(0);
  const dz = span(2);
  const h = Math.hypot(dx, dz);
  return { pos: [at(0), at(1), at(2)], dir: h > 1e-6 ? [dx / h, dz / h] : [1, 0] };
}

/** Tick spacings on offer, metres. */
export const TICK_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000] as const;
/** At most this many ticks along a clip. */
export const MAX_TICKS = 300;

/**
 * Tick spacing for the zoom: the smallest step at least `minPx` pixels long on screen at
 * `metresPerPx`, and coarse enough that a path of `length` metres gets at most MAX_TICKS ticks.
 */
export function tickStep(metresPerPx: number, length: number, minPx = 56): number {
  for (const s of TICK_STEPS) if (s >= metresPerPx * minPx && length / s <= MAX_TICKS) return s;
  return 1000;
}

/** Distances of the ticks every `step` metres from the clip start up to `upTo` (exclusive of 0). */
export function tickDistances(step: number, upTo: number): number[] {
  const out: number[] = [];
  if (!(step > 0)) return out;
  for (let k = 1; k * step <= upTo + 1e-9 && out.length < MAX_TICKS; k++) out.push(k * step);
  return out;
}

/** `250 m`, `1.25 km`: a tick label or the distance flown. */
export function formatDistance(m: number): string {
  if (m >= 1000) {
    const km = m / 1000;
    return `${km.toFixed(km >= 10 ? 1 : 2).replace(/\.?0+$/, '')} km`;
  }
  return `${m < 10 && m % 1 !== 0 ? m.toFixed(1) : Math.round(m).toString()} m`;
}

/** What the telemetry HUD reads at the playhead. */
export interface TraceReadout {
  /** Distance flown since the clip start, metres. */
  distanceM: number;
  /** Height above what lies under the drone (model, terrain or grade), metres; null unknown. */
  aglM: number | null;
  /** Project height (EL) of the camera, metres: manifest origin height plus local y. */
  elevationM: number;
  /** Horizontal speed over the last and next half second, m/s. */
  groundSpeedMps: number;
  /** Heading of the view, degrees clockwise from north. */
  headingDeg: number;
  /** Gimbal pitch, degrees; negative looks down. */
  gimbalDeg: number;
  /** Seconds since the clip start. */
  clipS: number;
}

export interface ReadoutInput {
  samples: readonly PoseSample[];
  /** Playhead in flight time (ms since the flight start). */
  flightMs: number;
  /** Clip start in flight time. */
  clipStartMs: number;
  profile: TraceProfile;
  /** Calibration of the clip (A1): camera position offset and orientation bias. */
  offset?: Vec3 | null | undefined;
  orientation?: CameraOrientation | null | undefined;
  /**
   * The camera orientation in use at the playhead (direction keyframes or the calibrated log);
   * wins over `orientation`.
   */
  q?: Quat | null | undefined;
  /** Local y of the ground under the drone, if known. */
  groundY: number | null;
  /** Manifest origin height (`origin[2]`). */
  originH: number;
}

/** HUD values from the calibrated flight pose at the playhead. */
export function traceReadout(i: ReadoutInput): TraceReadout {
  const pose = interpolatePose(i.samples, i.flightMs);
  const y = pose.pos[1] + (i.offset?.[1] ?? 0);
  const first = i.samples[0]?.t ?? 0;
  const last = i.samples[i.samples.length - 1]?.t ?? 0;
  const ta = Math.max(first, i.flightMs - 500);
  const tb = Math.min(last, i.flightMs + 500);
  let gs = 0;
  if (tb - ta > 1e-6) {
    const a = interpolatePose(i.samples, ta).pos;
    const b = interpolatePose(i.samples, tb).pos;
    gs = Math.hypot(b[0] - a[0], b[2] - a[2]) / ((tb - ta) / 1000);
  }
  const angles = cameraAngles(i.q ?? orientCamera(pose.q, i.orientation ?? undefined));
  return {
    distanceM: distanceAt(i.profile, i.flightMs),
    aglM: i.groundY === null ? null : y - i.groundY,
    elevationM: i.originH + y,
    groundSpeedMps: gs,
    headingDeg: angles.headingDeg,
    gimbalDeg: angles.pitchDeg,
    clipS: Math.max(0, (i.flightMs - i.clipStartMs) / 1000),
  };
}

/** `T+01:23` style clip time, minutes and seconds (hours when needed). */
export function formatClipTime(s: number): string {
  const total = Math.max(0, Math.floor(s));
  const p2 = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  return h > 0 ? `${h}:${p2(m)}:${p2(total % 60)}` : `${p2(m)}:${p2(total % 60)}`;
}

/** A screen rectangle, CSS pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelCandidate extends Box {
  id: string;
  priority: number;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Greedy label placement: by priority, each label only where it overlaps no placed label and no
 * obstacle (the HUD, the stage UI keep-out) and lies inside `bounds`. Returns the placed ids.
 */
export function placeLabels(
  cands: readonly LabelCandidate[],
  obstacles: readonly Box[],
  bounds: Box,
): Set<string> {
  const placed: Box[] = [];
  const out = new Set<string>();
  for (const c of [...cands].sort((a, b) => b.priority - a.priority)) {
    if (
      c.x < bounds.x ||
      c.y < bounds.y ||
      c.x + c.w > bounds.x + bounds.w ||
      c.y + c.h > bounds.y + bounds.h
    )
      continue;
    if (placed.some((p) => overlaps(p, c)) || obstacles.some((o) => overlaps(o, c))) continue;
    placed.push(c);
    out.add(c.id);
  }
  return out;
}
