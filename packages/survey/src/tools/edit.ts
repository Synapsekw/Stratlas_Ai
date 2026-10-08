import type { MeasurementFamily } from '@aio/schema';
import type { ScreenPt, ToScreen } from './draw';
import { lerp3, type Pt } from './geometry';

/**
 * Vertex editing of a saved shape (PRD SRV-5): drag a vertex, insert one at a segment's midpoint,
 * delete one (never below the family's minimum), or type its coordinates. Pure functions on the
 * points (E, N, Z in the project CRS) and a small drag state machine; the views hit-test through
 * their own `ToScreen`.
 */

const MIN: Record<MeasurementFamily, number> = { point: 1, line: 2, polygon: 3, markup: 2 };

export const isClosed = (family: MeasurementFamily): boolean => family === 'polygon';

export function moveVertex(points: readonly Pt[], i: number, p: Pt): Pt[] {
  if (i < 0 || i >= points.length) return [...points];
  return points.map((q, k) => (k === i ? p : q));
}

/** The midpoint of segment `seg` (from vertex seg to seg + 1, or the closing segment). */
export function midpoint(points: readonly Pt[], seg: number, closed: boolean): Pt | null {
  const a = points[seg];
  const b = points[seg + 1] ?? (closed ? points[0] : undefined);
  return a && b ? lerp3(a, b, 0.5) : null;
}

/** Insert a vertex at the midpoint of segment `seg`; `z` overrides its height (the terrain). */
export function insertMidpoint(
  points: readonly Pt[],
  seg: number,
  closed: boolean,
  z?: number | null,
): Pt[] {
  const m = midpoint(points, seg, closed);
  if (!m) return [...points];
  const p: Pt = z === null || z === undefined ? m : [m[0], m[1], z];
  return [...points.slice(0, seg + 1), p, ...points.slice(seg + 1)];
}

/** Delete vertex `i`; null when the shape would have too few vertices left. */
export function deleteVertex(
  points: readonly Pt[],
  i: number,
  family: MeasurementFamily,
): Pt[] | null {
  if (i < 0 || i >= points.length || points.length - 1 < MIN[family]) return null;
  return points.filter((_, k) => k !== i);
}

/** Set some of a vertex's coordinates (typed in the panel). */
export function setVertexCoords(
  points: readonly Pt[],
  i: number,
  c: { e?: number; n?: number; z?: number },
): Pt[] {
  const p = points[i];
  if (!p) return [...points];
  return moveVertex(points, i, [c.e ?? p[0], c.n ?? p[1], c.z ?? p[2]]);
}

/** The vertex under the cursor (nearest within the tolerance), or null. */
export function hitVertex(
  points: readonly Pt[],
  cursor: ScreenPt,
  toScreen: ToScreen,
  tolerancePx = 8,
): number | null {
  let best: number | null = null;
  let bestD = tolerancePx;
  points.forEach((p, i) => {
    const s = toScreen(p);
    if (!s) return;
    const d = Math.hypot(s.x - cursor.x, s.y - cursor.y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The segment whose midpoint handle is under the cursor, or null. */
export function hitMidpoint(
  points: readonly Pt[],
  closed: boolean,
  cursor: ScreenPt,
  toScreen: ToScreen,
  tolerancePx = 8,
): number | null {
  const n = closed && points.length > 2 ? points.length : points.length - 1;
  let best: number | null = null;
  let bestD = tolerancePx;
  for (let seg = 0; seg < n; seg++) {
    const m = midpoint(points, seg, closed);
    const s = m && toScreen(m);
    if (!s) continue;
    const d = Math.hypot(s.x - cursor.x, s.y - cursor.y);
    if (d <= bestD) {
      bestD = d;
      best = seg;
    }
  }
  return best;
}

// ---------------------------------------------------------------- dragging

export interface EditState {
  points: Pt[];
  /** The vertex being dragged. */
  dragging: number | null;
  /** The points before the drag, for Esc. */
  before: Pt[] | null;
  /** Something changed since the shape was loaded (the panel offers Save). */
  dirty: boolean;
}

export type EditEvent =
  | { type: 'down'; vertex: number }
  /** Pressed on a midpoint handle: insert there and drag the new vertex. */
  | { type: 'down-mid'; seg: number; z?: number | null }
  | { type: 'drag'; p: Pt }
  | { type: 'up' }
  | { type: 'delete'; vertex: number }
  | { type: 'set'; vertex: number; coords: { e?: number; n?: number; z?: number } }
  | { type: 'escape' };

export const initialEdit = (points: readonly Pt[]): EditState => ({
  points: [...points],
  dragging: null,
  before: null,
  dirty: false,
});

export function editReducer(s: EditState, e: EditEvent, family: MeasurementFamily): EditState {
  switch (e.type) {
    case 'down':
      return e.vertex >= 0 && e.vertex < s.points.length
        ? { ...s, dragging: e.vertex, before: s.points }
        : s;
    case 'down-mid': {
      const points = insertMidpoint(s.points, e.seg, isClosed(family), e.z);
      if (points.length === s.points.length) return s;
      return { points, dragging: e.seg + 1, before: s.points, dirty: true };
    }
    case 'drag':
      return s.dragging === null
        ? s
        : { ...s, points: moveVertex(s.points, s.dragging, e.p), dirty: true };
    case 'up':
      return { ...s, dragging: null, before: null };
    case 'delete': {
      const points = deleteVertex(s.points, e.vertex, family);
      return points ? { ...s, points, dirty: true } : s;
    }
    case 'set':
      return { ...s, points: setVertexCoords(s.points, e.vertex, e.coords), dirty: true };
    case 'escape':
      return s.before ? { ...s, points: s.before, dragging: null, before: null } : s;
  }
}
