import type { ImageGeom, Vec2 } from '@aio/schema';

/*
 * 2D image geometry for the photo and video annotators. View maths, rotated boxes and hit tests
 * are adapted from Kestrel's image canvas (E:\Dev\Yolo\app\frontend\src\images\canvas\geometry.ts,
 * MIT). Shapes use the schema's ImageGeom in image pixels; a rotated box's x, y, w, h describe the
 * unrotated box and `angleDeg` turns it clockwise about its centre.
 */

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
/** display = image * scale + (x, y). */
export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 32;
export const ZOOM_STEP = 1.15;
export const MIN_BOX_SIDE = 2;

export type Box = Extract<ImageGeom, { type: 'box' }>;
export type RotBox = Extract<ImageGeom, { type: 'rotbox' }>;
export type Polygon = Extract<ImageGeom, { type: 'polygon' }>;
export type EditableGeom = Exclude<ImageGeom, { type: 'mask' }>;

export const toImage = (p: Point, v: ViewTransform): Point => ({
  x: (p.x - v.x) / v.scale,
  y: (p.y - v.y) / v.scale,
});
export const toDisplay = (p: Point, v: ViewTransform): Point => ({
  x: p.x * v.scale + v.x,
  y: p.y * v.scale + v.y,
});
export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function fitView(image: Size, viewport: Size, padding = 8): ViewTransform {
  const availW = Math.max(1, viewport.width - 2 * padding);
  const availH = Math.max(1, viewport.height - 2 * padding);
  const scale = clampScale(Math.min(availW / image.width, availH / image.height));
  return {
    scale,
    x: (viewport.width - image.width * scale) / 2,
    y: (viewport.height - image.height * scale) / 2,
  };
}

export function zoomAround(v: ViewTransform, at: Point, factor: number): ViewTransform {
  const scale = clampScale(v.scale * factor);
  const anchor = toImage(at, v);
  return { scale, x: at.x - anchor.x * scale, y: at.y - anchor.y * scale };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Axis-aligned box from a drag in image pixels, clamped; null for a click or a sliver. */
export function boxFromDrag(a: Point, b: Point, image: Size): Box | null {
  const x0 = clamp(Math.min(a.x, b.x), 0, image.width);
  const y0 = clamp(Math.min(a.y, b.y), 0, image.height);
  const x1 = clamp(Math.max(a.x, b.x), 0, image.width);
  const y1 = clamp(Math.max(a.y, b.y), 0, image.height);
  if (x1 - x0 < MIN_BOX_SIDE || y1 - y0 < MIN_BOX_SIDE) return null;
  const r = (n: number) => Math.round(n * 10) / 10;
  return { type: 'box', x: r(x0), y: r(y0), w: r(x1 - x0), h: r(y1 - y0) };
}

const normaliseAngle = (deg: number) => {
  const m = deg % 180;
  return m < 0 ? m + 180 : m;
};

/** Kestrel's three-point gesture: a to b is one edge, c sets the other side. */
export function rboxFromThreePoints(a: Point, b: Point, c: Point): RotBox | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < MIN_BOX_SIDE) return null;
  const nx = -dy / len;
  const ny = dx / len;
  const d = (c.x - a.x) * nx + (c.y - a.y) * ny;
  if (Math.abs(d) < MIN_BOX_SIDE) return null;
  const cx = (a.x + b.x) / 2 + (nx * d) / 2;
  const cy = (a.y + b.y) / 2 + (ny * d) / 2;
  const h = Math.abs(d);
  return {
    type: 'rotbox',
    x: cx - len / 2,
    y: cy - h / 2,
    w: len,
    h,
    angleDeg: normaliseAngle((Math.atan2(dy, dx) * 180) / Math.PI),
  };
}

/** Corners of a rotated box, clockwise from its rotated top-left. */
export function cornersOf(r: RotBox | Box): [Point, Point, Point, Point] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rad = ((r.type === 'rotbox' ? r.angleDeg : 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const at = (dx: number, dy: number): Point => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  });
  const hw = r.w / 2;
  const hh = r.h / 2;
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** Outline points of a shape in image pixels (one point for a point, none for a mask). */
export function geomOutline(g: ImageGeom): Point[] {
  switch (g.type) {
    case 'box':
    case 'rotbox':
      return cornersOf(g);
    case 'polygon':
      return g.points.map(([x, y]) => ({ x, y }));
    case 'point':
      return [{ x: g.x, y: g.y }];
    case 'mask':
      return [];
  }
}

function insidePolygon(p: Point, pts: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Does an image point hit the shape? `tol` is in image pixels (points, edges). */
export function hitGeom(g: ImageGeom, p: Point, tol: number): boolean {
  if (g.type === 'point') return Math.hypot(p.x - g.x, p.y - g.y) <= tol;
  if (g.type === 'mask') return false;
  return insidePolygon(p, geomOutline(g));
}

export function translateGeom<G extends ImageGeom>(g: G, dx: number, dy: number): G {
  switch (g.type) {
    case 'box':
    case 'rotbox':
    case 'point':
      return { ...g, x: g.x + dx, y: g.y + dy };
    case 'polygon':
      return { ...g, points: g.points.map(([x, y]): Vec2 => [x + dx, y + dy]) };
    default:
      return g;
  }
}

/** Handle positions for editing: box corners, polygon vertices, the point itself. */
export function handlesOf(g: ImageGeom): Point[] {
  return g.type === 'mask' ? [] : geomOutline(g);
}

/**
 * Drag handle `i` to image point `to`. Box corners resize with the opposite corner fixed;
 * rotated boxes resize along their own axes; polygon vertices and points move.
 */
export function dragHandle<G extends ImageGeom>(g: G, i: number, to: Point): G {
  switch (g.type) {
    case 'point':
      return { ...g, x: to.x, y: to.y };
    case 'polygon':
      return { ...g, points: g.points.map((p, k): Vec2 => (k === i ? [to.x, to.y] : p)) };
    case 'box': {
      const c = cornersOf(g);
      const opp = c[(i + 2) % 4] ?? c[0];
      const x = Math.min(opp.x, to.x);
      const y = Math.min(opp.y, to.y);
      return {
        ...g,
        x,
        y,
        w: Math.max(MIN_BOX_SIDE, Math.abs(to.x - opp.x)),
        h: Math.max(MIN_BOX_SIDE, Math.abs(to.y - opp.y)),
      };
    }
    case 'rotbox': {
      const c = cornersOf(g);
      const opp = c[(i + 2) % 4] ?? c[0];
      const rad = (g.angleDeg * Math.PI) / 180;
      const ux = { x: Math.cos(rad), y: Math.sin(rad) };
      const uy = { x: -Math.sin(rad), y: Math.cos(rad) };
      const dx = to.x - opp.x;
      const dy = to.y - opp.y;
      const along = dx * ux.x + dy * ux.y;
      const across = dx * uy.x + dy * uy.y;
      const w = Math.max(MIN_BOX_SIDE, Math.abs(along));
      const h = Math.max(MIN_BOX_SIDE, Math.abs(across));
      const cx = opp.x + (ux.x * along + uy.x * across) / 2;
      const cy = opp.y + (ux.y * along + uy.y * across) / 2;
      return { ...g, x: cx - w / 2, y: cy - h / 2, w, h };
    }
    default:
      return g;
  }
}
