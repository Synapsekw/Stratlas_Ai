import type { FrameGeom, ImageGeom, Vec2 } from '@aio/schema';
import { cornersOf, geomOutline, MIN_BOX_SIDE, type Point, type Size } from '../image/geometry';

/*
 * Geometry editing for detection review, on top of the annotator's 2D maths (image/geometry.ts):
 * polygon vertex insert and delete, clamping to the image, conversions from normalised model
 * output to pixels, and to the shapes a video sighting accepts.
 */

export type Polygon = Extract<ImageGeom, { type: 'polygon' }>;
/** A shape a detection can have (every image shape but a mask). */
export type ShapeGeom = Exclude<ImageGeom, { type: 'mask' }>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The polygon edge nearest to `p` (edge i runs from vertex i to i + 1) and its distance. */
export function nearestEdge(poly: Polygon, p: Point): { index: number; distance: number } {
  let best = { index: 0, distance: Infinity };
  const n = poly.points.length;
  for (let i = 0; i < n; i++) {
    const a = poly.points[i];
    const b = poly.points[(i + 1) % n];
    if (!a || !b) continue;
    const d = distToSegment(p, { x: a[0], y: a[1] }, { x: b[0], y: b[1] });
    if (d < best.distance) best = { index: i, distance: d };
  }
  return best;
}

/** Insert a vertex after vertex `after` (on edge `after`). */
export function insertVertex(poly: Polygon, after: number, p: Point): Polygon {
  const points = [...poly.points];
  points.splice(after + 1, 0, [round1(p.x), round1(p.y)]);
  return { ...poly, points };
}

/** Remove vertex `i`; null when the polygon would have fewer than three vertices. */
export function removeVertex(poly: Polygon, i: number): Polygon | null {
  if (poly.points.length <= 3 || i < 0 || i >= poly.points.length) return null;
  return { ...poly, points: poly.points.filter((_, k) => k !== i) };
}

/** Keep a shape inside the image (a box is cut at the edges, vertices are pulled in). */
export function clampGeom<G extends ImageGeom>(g: G, size: Size): G {
  const W = size.width;
  const H = size.height;
  switch (g.type) {
    case 'box': {
      const x0 = clamp(g.x, 0, W);
      const y0 = clamp(g.y, 0, H);
      const x1 = clamp(g.x + g.w, 0, W);
      const y1 = clamp(g.y + g.h, 0, H);
      return {
        ...g,
        x: x0,
        y: y0,
        w: Math.max(MIN_BOX_SIDE, x1 - x0),
        h: Math.max(MIN_BOX_SIDE, y1 - y0),
      };
    }
    case 'polygon':
      return { ...g, points: g.points.map(([x, y]): Vec2 => [clamp(x, 0, W), clamp(y, 0, H)]) };
    case 'point':
      return { ...g, x: clamp(g.x, 0, W), y: clamp(g.y, 0, H) };
    default:
      return g;
  }
}

/**
 * A normalised box `[x, y, w, h]` (0 to 1 of the image, top-left origin) in pixels, or null when
 * it is not a usable box (outside the image, empty, not numbers).
 */
export function normBoxToPixels(box: readonly number[], size: Size): ShapeGeom | null {
  const [x, y, w, h] = box;
  if ([x, y, w, h].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  const x0 = clamp(x ?? 0, 0, 1) * size.width;
  const y0 = clamp(y ?? 0, 0, 1) * size.height;
  const x1 = clamp((x ?? 0) + (w ?? 0), 0, 1) * size.width;
  const y1 = clamp((y ?? 0) + (h ?? 0), 0, 1) * size.height;
  if (x1 - x0 < MIN_BOX_SIDE || y1 - y0 < MIN_BOX_SIDE) return null;
  return { type: 'box', x: round1(x0), y: round1(y0), w: round1(x1 - x0), h: round1(y1 - y0) };
}

/** A normalised polygon (0 to 1 pairs) in pixels, or null with fewer than three usable points. */
export function normPolygonToPixels(pts: readonly unknown[], size: Size): ShapeGeom | null {
  const points: Vec2[] = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const [x, y] = p as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push([round1(clamp(x, 0, 1) * size.width), round1(clamp(y, 0, 1) * size.height)]);
  }
  return points.length >= 3 ? { type: 'polygon', points } : null;
}

/** Axis-aligned bounds of a shape in image pixels (null for a mask). */
export function geomBounds(g: ImageGeom): { x: number; y: number; w: number; h: number } | null {
  const pts = geomOutline(g);
  if (pts.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Half side of the box a point becomes on a video frame. */
const POINT_BOX = 8;

/**
 * The shape for a video sighting keyframe (box or polygon): a rotated box becomes its corner
 * polygon, a point a small box. A mask has no frame shape (null).
 */
export function toFrameGeom(g: ImageGeom): FrameGeom | null {
  switch (g.type) {
    case 'box':
    case 'polygon':
      return g;
    case 'rotbox':
      return { type: 'polygon', points: cornersOf(g).map((p): Vec2 => [p.x, p.y]) };
    case 'point':
      return {
        type: 'box',
        x: g.x - POINT_BOX,
        y: g.y - POINT_BOX,
        w: POINT_BOX * 2,
        h: POINT_BOX * 2,
      };
    case 'mask':
      return null;
  }
}

/** Area in square pixels (shoelace for outlines; 0 for points and masks). */
export function geomArea(g: ImageGeom): number {
  if (g.type === 'box' || g.type === 'rotbox') return g.w * g.h;
  if (g.type !== 'polygon') return 0;
  let a = 0;
  const n = g.points.length;
  for (let i = 0; i < n; i++) {
    const p = g.points[i];
    const q = g.points[(i + 1) % n];
    if (p && q) a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Intersection over union of two shapes' bounds (for de-duplicating proposals). */
export function boundsIou(a: ImageGeom, b: ImageGeom): number {
  const A = geomBounds(a);
  const B = geomBounds(b);
  if (!A || !B) return 0;
  const ix = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
  const iy = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
  const inter = ix * iy;
  const union = A.w * A.h + B.w * B.h - inter;
  return union > 0 ? inter / union : 0;
}

/** A shape scaled by `sx`, `sy` (between pixel grids; a rotated box keeps its angle). */
export function scaleGeom<G extends ImageGeom>(g: G, sx: number, sy: number): G {
  switch (g.type) {
    case 'box':
    case 'rotbox':
      return { ...g, x: g.x * sx, y: g.y * sy, w: g.w * sx, h: g.h * sy };
    case 'point':
      return { ...g, x: g.x * sx, y: g.y * sy };
    case 'polygon':
      return { ...g, points: g.points.map(([x, y]): Vec2 => [x * sx, y * sy]) };
    default:
      return g;
  }
}
