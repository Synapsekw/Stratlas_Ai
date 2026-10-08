import type { DistanceUnit, MeasurementFamily } from '@aio/schema';
import { toSi } from './format';
import {
  bearingDeg,
  closestOnSegment2,
  horizontalDistance,
  lerp3,
  pointAtBearing,
  type Pt,
} from './geometry';

/**
 * Drawing aids (PRD SRV-5) as pure state machines, shared by the 3D site view and the 2D map: the
 * geometry is always site points (E, N, Z) in the project CRS, and each view supplies how a site
 * point lands on its screen (`ToScreen`) and how the terrain is read (`clampZ`, from the existing
 * picking on meshes, clouds and DSMs).
 *
 * The order for each cursor position: snapping (vertices before edges, within a pixel tolerance)
 * or, while Shift is held, the angle lock (15 degree steps and the last segment's bearing); then a
 * typed bearing; then the terrain under the point. Enter with a typed distance adds the point that
 * far along the current direction. Esc clears what was typed, then cancels the drawing.
 */

export interface ScreenPt {
  x: number;
  y: number;
}

/** Where a site point is on the screen, or null when it is behind the camera or off the map. */
export type ToScreen = (p: Pt) => ScreenPt | null;

// ---------------------------------------------------------------- snapping

export type SnapSource = 'measurement' | 'design' | 'alignment' | 'guide';

/** Snap targets from one source (saved measurements; G6's designs and alignments; guidelines). */
export interface SnapProvider {
  source: SnapSource;
  vertices(): readonly Pt[];
  segments(): readonly (readonly [Pt, Pt])[];
}

export interface SnapSettings {
  /** Each source on or off. */
  sources: Record<SnapSource, boolean>;
  vertices: boolean;
  edges: boolean;
  /** How close the cursor must be, screen pixels. */
  tolerancePx: number;
}

export const DEFAULT_SNAP: SnapSettings = {
  sources: { measurement: true, design: true, alignment: true, guide: true },
  vertices: true,
  edges: true,
  tolerancePx: 10,
};

export interface SnapHit {
  point: Pt;
  source: SnapSource;
  kind: 'vertex' | 'edge';
  distancePx: number;
}

/**
 * The snap under the cursor: the nearest vertex within the tolerance, else the nearest point on an
 * edge within it (vertices win, so a corner is easy to hit). Null when nothing is close.
 */
export function findSnap(
  cursor: ScreenPt,
  providers: readonly SnapProvider[],
  toScreen: ToScreen,
  settings: SnapSettings = DEFAULT_SNAP,
): SnapHit | null {
  let best: SnapHit | null = null;
  const tol = settings.tolerancePx;
  const on = providers.filter((p) => settings.sources[p.source]);
  if (settings.vertices) {
    for (const p of on) {
      for (const v of p.vertices()) {
        const s = toScreen(v);
        if (!s) continue;
        const d = Math.hypot(s.x - cursor.x, s.y - cursor.y);
        if (d <= tol && (!best || d < best.distancePx))
          best = { point: v, source: p.source, kind: 'vertex', distancePx: d };
      }
    }
  }
  if (best || !settings.edges) return best;
  for (const p of on) {
    for (const [a, b] of p.segments()) {
      const sa = toScreen(a);
      const sb = toScreen(b);
      if (!sa || !sb) continue;
      const { t, d } = closestOnSegment2([cursor.x, cursor.y], [sa.x, sa.y], [sb.x, sb.y]);
      if (d <= tol && (!best || d < best.distancePx))
        best = { point: lerp3(a, b, t), source: p.source, kind: 'edge', distancePx: d };
    }
  }
  return best;
}

/** Snap targets of saved measurements (their vertices and edges; polygons closed). */
export function measurementSnaps(
  shapes: readonly { points: readonly Pt[]; closed: boolean }[],
): SnapProvider {
  return {
    source: 'measurement',
    vertices: () => shapes.flatMap((s) => s.points),
    segments: () =>
      shapes.flatMap((s) => {
        const out: [Pt, Pt][] = [];
        for (let i = 1; i < s.points.length; i++) {
          const a = s.points[i - 1];
          const b = s.points[i];
          if (a && b) out.push([a, b]);
        }
        const first = s.points[0];
        const last = s.points[s.points.length - 1];
        if (s.closed && s.points.length > 2 && first && last) out.push([last, first]);
        return out;
      }),
  };
}

// ---------------------------------------------------------------- angle lock

/**
 * The bearings the angle lock offers: every `stepDeg` from north, and the last segment's bearing
 * with its reverse and perpendiculars.
 */
export function lockBearings(stepDeg = 15, lastBearing?: number): number[] {
  const out: number[] = [];
  for (let b = 0; b < 360; b += stepDeg) out.push(b);
  if (lastBearing !== undefined)
    for (const d of [0, 90, 180, 270]) out.push((((lastBearing + d) % 360) + 360) % 360);
  return out;
}

const angleGap = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(d, 360 - d);
};

/**
 * Lock the segment from `prev` toward `cursor` to the nearest offered bearing; the length is the
 * cursor's distance along that bearing (never behind `prev`).
 */
export function lockAngle(
  prev: Pt,
  cursor: Pt,
  stepDeg = 15,
  lastBearing?: number,
): { point: Pt; bearing: number } {
  const raw = bearingDeg(prev, cursor);
  let bearing = 0;
  let gap = Infinity;
  for (const b of lockBearings(stepDeg, lastBearing)) {
    const g = angleGap(raw, b);
    if (g < gap - 1e-12) {
      gap = g;
      bearing = b;
    }
  }
  const r = (bearing * Math.PI) / 180;
  const along = Math.max(
    0,
    (cursor[0] - prev[0]) * Math.sin(r) + (cursor[1] - prev[1]) * Math.cos(r),
  );
  return { point: pointAtBearing(prev, bearing, along, cursor[2]), bearing };
}

// ---------------------------------------------------------------- typed values

/** Parse a typed number ("25", "12.5", "-3"); null when it is not one. */
export function parseTyped(text: string): number | null {
  const t = text.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** A typed bearing in degrees: plain degrees, or degrees, minutes and seconds ("45 30 15"). */
export function parseBearing(text: string): number | null {
  const parts = text
    .trim()
    .split(/[\s°'"]+/)
    .filter((p) => p !== '');
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = parts.map((p) => parseTyped(p));
  if (nums.some((n) => n === null || n < 0)) return null;
  const [d = 0, m = 0, s = 0] = nums as number[];
  if (m >= 60 || s >= 60) return null;
  const deg = d + m / 60 + s / 3600;
  return deg < 360 ? deg : null;
}

// ---------------------------------------------------------------- the drawing

const MIN: Record<MeasurementFamily, number> = { point: 1, line: 2, polygon: 3, markup: 2 };

export interface DrawState {
  family: MeasurementFamily;
  points: Pt[];
  /** The point the next click adds (after the aids), or null before the cursor is over the site. */
  cursor: Pt | null;
  snap: SnapHit | null;
  /** The bearing the angle lock or a typed bearing holds, while it holds. */
  lockedBearing: number | null;
  typing: { field: 'distance' | 'bearing'; distance: string; bearing: string };
  /** The shape is complete (Enter, double click, or one click for a point). */
  done: boolean;
  /** Esc cancelled the drawing. */
  cancelled: boolean;
}

export type DrawEvent =
  | { type: 'move'; raw: Pt; screen: ScreenPt; shift: boolean }
  | { type: 'click'; raw: Pt; screen: ScreenPt; shift: boolean }
  /** A freehand stroke: points added while the button is held. */
  | { type: 'stroke'; raw: Pt }
  | { type: 'key'; key: string }
  | { type: 'finish' }
  | { type: 'undo' }
  | { type: 'cancel' };

export interface DrawEnv {
  /** The snap under the cursor (`findSnap` with this view's providers and projection). */
  snap?: ((screen: ScreenPt) => SnapHit | null) | undefined;
  /** Terrain height at (E, N) for points the aids construct, or null where there is none. */
  clampZ?: ((e: number, n: number) => number | null) | undefined;
  /** The unit a typed distance is in (the measurement's display unit). */
  distanceUnit?: DistanceUnit | undefined;
  stepDeg?: number | undefined;
  /** Minimum spacing between freehand points, metres. */
  strokeSpacingM?: number | undefined;
}

export function initialDraw(family: MeasurementFamily): DrawState {
  return {
    family,
    points: [],
    cursor: null,
    snap: null,
    lockedBearing: null,
    typing: { field: 'distance', distance: '', bearing: '' },
    done: false,
    cancelled: false,
  };
}

const lastBearingOf = (pts: readonly Pt[]): number | undefined => {
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  return a && b && horizontalDistance(a, b) > 0 ? bearingDeg(a, b) : undefined;
};

function clamp(p: Pt, env: DrawEnv): Pt {
  const z = env.clampZ?.(p[0], p[1]);
  return z === null || z === undefined ? p : [p[0], p[1], z];
}

/** The aided cursor for a raw pick: snap or angle lock, then a typed bearing, then the terrain. */
export function aidedPoint(
  s: DrawState,
  raw: Pt,
  screen: ScreenPt,
  shift: boolean,
  env: DrawEnv,
): { point: Pt; snap: SnapHit | null; bearing: number | null } {
  const prev = s.points[s.points.length - 1];
  const typedBearing = parseBearing(s.typing.bearing);
  if (prev && typedBearing !== null) {
    const r = (typedBearing * Math.PI) / 180;
    const along = Math.max(0, (raw[0] - prev[0]) * Math.sin(r) + (raw[1] - prev[1]) * Math.cos(r));
    return {
      point: clamp(pointAtBearing(prev, typedBearing, along, raw[2]), env),
      snap: null,
      bearing: typedBearing,
    };
  }
  if (prev && shift) {
    const l = lockAngle(prev, raw, env.stepDeg ?? 15, lastBearingOf(s.points));
    return { point: clamp(l.point, env), snap: null, bearing: l.bearing };
  }
  const hit = env.snap?.(screen) ?? null;
  if (hit) return { point: hit.point, snap: hit, bearing: null };
  return { point: raw, snap: null, bearing: null };
}

function add(s: DrawState, p: Pt): DrawState {
  const points = [...s.points, p];
  return {
    ...s,
    points,
    snap: null,
    typing: { ...s.typing, distance: '', bearing: '' },
    lockedBearing: null,
    done: s.family === 'point',
  };
}

/** The point a typed distance gives: from the last point along the held or cursor bearing. */
export function typedPoint(s: DrawState, env: DrawEnv): Pt | null {
  const prev = s.points[s.points.length - 1];
  const typed = parseTyped(s.typing.distance);
  if (!prev || typed === null || typed <= 0) return null;
  const dist = toSi(typed, 'distance', env.distanceUnit ?? 'm');
  const bearing =
    parseBearing(s.typing.bearing) ??
    s.lockedBearing ??
    (s.cursor && horizontalDistance(prev, s.cursor) > 0 ? bearingDeg(prev, s.cursor) : null) ??
    lastBearingOf(s.points) ??
    0;
  return clamp(pointAtBearing(prev, bearing, dist), env);
}

const TYPED = /^[0-9.\-\s'"°]$/;

export function drawReducer(s: DrawState, e: DrawEvent, env: DrawEnv = {}): DrawState {
  if (s.cancelled && e.type !== 'cancel') return s;
  const fresh = s.done ? { ...initialDraw(s.family), cursor: s.cursor } : s;
  switch (e.type) {
    case 'move': {
      const a = aidedPoint(fresh, e.raw, e.screen, e.shift, env);
      return { ...fresh, cursor: a.point, snap: a.snap, lockedBearing: a.bearing };
    }
    case 'click': {
      const a = aidedPoint(fresh, e.raw, e.screen, e.shift, env);
      return add({ ...fresh, cursor: a.point }, a.point);
    }
    case 'stroke': {
      const last = fresh.points[fresh.points.length - 1];
      if (last && horizontalDistance(last, e.raw) < (env.strokeSpacingM ?? 0.1)) return fresh;
      return { ...fresh, points: [...fresh.points, e.raw], cursor: e.raw };
    }
    case 'key': {
      const t = fresh.typing;
      const field = t.field;
      if (e.key === 'Escape') {
        if (t.distance || t.bearing)
          return { ...fresh, typing: { ...t, distance: '', bearing: '' }, lockedBearing: null };
        return { ...initialDraw(fresh.family), cancelled: true };
      }
      if (e.key === 'Tab') {
        return { ...fresh, typing: { ...t, field: field === 'distance' ? 'bearing' : 'distance' } };
      }
      if (e.key === 'Backspace') {
        if (t[field]) return { ...fresh, typing: { ...t, [field]: t[field].slice(0, -1) } };
        return drawReducer(fresh, { type: 'undo' }, env);
      }
      if (e.key === 'Enter') {
        const p = typedPoint(fresh, env);
        if (p) return add(fresh, p);
        return drawReducer(fresh, { type: 'finish' }, env);
      }
      if (TYPED.test(e.key) && fresh.points.length > 0 && fresh.family !== 'point') {
        // a bearing may hold spaces and DMS marks; a distance only a number
        if (field === 'distance' && !/^[0-9.-]$/.test(e.key)) return fresh;
        return { ...fresh, typing: { ...t, [field]: t[field] + e.key } };
      }
      return fresh;
    }
    case 'finish':
      return fresh.points.length >= MIN[fresh.family] ? { ...fresh, done: true } : fresh;
    case 'undo':
      return { ...fresh, points: fresh.points.slice(0, -1), done: false };
    case 'cancel':
      return { ...initialDraw(s.family), cancelled: true };
  }
}

/** True when the drawing has enough vertices to save. */
export const canFinish = (s: DrawState): boolean => s.points.length >= MIN[s.family];
