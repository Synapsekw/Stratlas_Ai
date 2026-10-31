import type { Bbox } from './packs';

/** The share of the view left clear on each side of the fitted data. */
export const FIT_PADDING = 0.08;
/**
 * The closest the map zooms when it fits a project: issue shapes show from z17 and issue clusters
 * break up at z19, so a small site opens close enough to read both.
 */
export const FIT_MAX_ZOOM = 19;
/**
 * The least ground, in metres, a fitted view shows across its narrower side. z19 is about 0.15 m a
 * pixel: a wide map shows a small site whole at z19, but a narrow pane (the 244 px Split map) would
 * show only some 35 m, so its zoom stops where this much ground still fits.
 */
export const FIT_MIN_SPAN_M = 60;

/** A camera that frames the data: centre [lon, lat] and MapLibre zoom (512 px tiles). */
export interface FitCamera {
  center: [number, number];
  zoom: number;
}

const MAX_LAT = 85.0511287798;

/** Mercator y in [0, 1] (0 at the north edge). */
function mercY(lat: number): number {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

/** Latitude of a Mercator y in [0, 1]. */
function latOf(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/** Metres of ground on the equator one pixel spans at zoom 0 (512 px tiles). */
const EQUATOR_M_PER_PX = 40_075_016.686 / 512;

/**
 * The camera that frames the union of `extents` ([west, south, east, north] degrees) in a view of
 * `view` pixels, with `padding` of the view's width and height clear on each side, never closer
 * than `maxZoom` nor so close that the view's narrower side shows less than `minSpanM` metres.
 * Null when there is nothing to frame. The map stays north up: a long corridor is framed as it
 * lies.
 */
export function fitFor(
  extents: readonly Bbox[],
  view: { width: number; height: number },
  {
    padding = FIT_PADDING,
    maxZoom = FIT_MAX_ZOOM,
    minSpanM = FIT_MIN_SPAN_M,
  }: { padding?: number; maxZoom?: number; minSpanM?: number } = {},
): FitCamera | null {
  if (extents.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const b of extents) {
    w = Math.min(w, b[0]);
    s = Math.min(s, b[1]);
    e = Math.max(e, b[2]);
    n = Math.max(n, b[3]);
  }
  if (!Number.isFinite(w) || !Number.isFinite(s)) return null;
  const top = mercY(n);
  const bottom = mercY(s);
  const fx = (e - w) / 360;
  const fy = Math.abs(bottom - top);
  const roomX = Math.max(1, view.width * (1 - 2 * padding));
  const roomY = Math.max(1, view.height * (1 - 2 * padding));
  const zx = fx > 0 ? Math.log2(roomX / (512 * fx)) : Infinity;
  const zy = fy > 0 ? Math.log2(roomY / (512 * fy)) : Infinity;
  const lat = latOf((top + bottom) / 2);
  // the zoom at which the narrower side shows `minSpanM` metres of ground
  const narrow = Math.max(1, Math.min(view.width, view.height));
  const zSpan = Math.log2(
    (EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180) * narrow) / Math.max(1e-6, minSpanM),
  );
  const zoom = Math.max(0, Math.min(maxZoom, zSpan, zx, zy));
  return { center: [(w + e) / 2, lat], zoom };
}
