/**
 * Paint the Earth's land and borders into one map tile (plate carrée: longitude across, latitude
 * down, as CesiumJS's geographic tiles are). The look follows the street style so the two meet
 * without a seam: flat water, flat land, country borders as hairlines that turn dashed from
 * level 4 on. Works on any 2D context that has the few calls of `Pen`, so tests record them.
 */
import { boxesMeet, type Box, type EarthPath, type EarthShapes } from './shapes';

/** The few 2D canvas calls the tile painter makes (`CanvasRenderingContext2D` has them all). */
export interface Pen {
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(rule?: 'nonzero' | 'evenodd'): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
}

/** Water, land and border colours (the street style's own). */
export interface EarthInk {
  water: string;
  land: string;
  border: string;
}

/** Tiles across at level 0 of CesiumJS's geographic tiling scheme (two 180 degree squares). */
const LEVEL_ZERO_TILES_X = 2;

/** The box of geographic tile `level/x/y` (y from the north). */
export function geographicTileBox(level: number, x: number, y: number): Box {
  const span = 360 / (LEVEL_ZERO_TILES_X * 2 ** level);
  const west = -180 + x * span;
  const north = 90 - y * span;
  return [west, north - span, west + span, north];
}

export interface EarthTileOptions {
  /** The tile's box in degrees. */
  box: Box;
  /** Its level: borders are dashed from level 4, as in the street style. */
  level: number;
  /** The edge of the square canvas, pixels. */
  size: number;
  /** Canvas pixels per CSS pixel (line widths are CSS pixels). */
  scale: number;
  ink: EarthInk;
}

export interface EarthTileStats {
  polygons: number;
  borders: number;
  /** Points handed to the canvas after the ones outside the tile were dropped. */
  points: number;
}

const LEFT = 1;
const RIGHT = 2;
const ABOVE = 4;
const BELOW = 8;

/**
 * Trace a path in tile pixels. Points outside the tile that sit between two neighbours on the
 * same outer side are dropped (what they enclose is off the canvas either way), and so are
 * points closer than `minStep` pixels to the one before: a continent costs a tile deep inside it
 * a handful of points, not thousands.
 */
function trace(
  pen: Pen,
  path: EarthPath,
  o: EarthTileOptions,
  dx: number,
  close: boolean,
  pad: number,
  minStep: number,
): number {
  const { pts } = path;
  const count = pts.length / 2;
  const [west, south, east, north] = o.box;
  const kx = o.size / (east - west);
  const ky = o.size / (north - south);
  const lo = -pad;
  const hi = o.size + pad;
  const px = (i: number) => ((pts[i * 2] ?? 0) + dx - west) * kx;
  const py = (i: number) => (north - (pts[i * 2 + 1] ?? 0)) * ky;
  const code = (x: number, y: number) =>
    (x < lo ? LEFT : x > hi ? RIGHT : 0) | (y < lo ? ABOVE : y > hi ? BELOW : 0);

  let emitted = 0;
  let lastX = 0;
  let lastY = 0;
  let lastCode = 0;
  let x = px(0);
  let y = py(0);
  let c = code(x, y);
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const nx = last ? (close ? px(0) : 0) : px(i + 1);
    const ny = last ? (close ? py(0) : 0) : py(i + 1);
    const nc = last && !close ? 0 : code(nx, ny);
    const edge = i === 0 || (last && !close);
    const outside = (c & lastCode & nc) !== 0;
    const near = Math.abs(x - lastX) < minStep && Math.abs(y - lastY) < minStep;
    if (edge || !(outside || near)) {
      if (emitted === 0) pen.moveTo(x, y);
      else pen.lineTo(x, y);
      emitted++;
      lastX = x;
      lastY = y;
      lastCode = c;
    }
    x = nx;
    y = ny;
    c = nc;
  }
  if (close) pen.closePath();
  return emitted;
}

/** The longitude shifts under which a shape may reach into the tile (the antimeridian wraps). */
function shifts(box: Box, tile: Box): number[] {
  const out: number[] = [];
  for (const dx of [0, -360, 360]) {
    if (boxesMeet([box[0] + dx, box[1], box[2] + dx, box[3]], tile)) out.push(dx);
  }
  return out;
}

/** Paint one tile: water, the land that reaches into it, then the borders. */
export function drawEarthTile(pen: Pen, shapes: EarthShapes, o: EarthTileOptions): EarthTileStats {
  const { size, scale, ink, box } = o;
  const stats: EarthTileStats = { polygons: 0, borders: 0, points: 0 };
  pen.fillStyle = ink.water;
  pen.fillRect(0, 0, size, size);

  // a little beyond the tile, so a border's line width never shows a cut at the edge
  const pad = 4 * scale;
  const padDeg = (pad * (box[2] - box[0])) / size;
  const reach: Box = [box[0] - padDeg, box[1] - padDeg, box[2] + padDeg, box[3] + padDeg];

  pen.beginPath();
  for (const polygon of shapes.land) {
    for (const dx of shifts(polygon.box, reach)) {
      stats.polygons++;
      for (const ring of polygon.rings) stats.points += trace(pen, ring, o, dx, true, pad, 0.35);
    }
  }
  pen.fillStyle = ink.land;
  pen.fill('evenodd');

  pen.beginPath();
  for (const border of shapes.borders) {
    for (const dx of shifts(border.box, reach)) {
      stats.borders++;
      stats.points += trace(pen, border, o, dx, false, pad, 0.35);
    }
  }
  const width = 0.7 * scale;
  pen.strokeStyle = ink.border;
  pen.lineWidth = width;
  pen.lineJoin = 'round';
  pen.lineCap = 'butt';
  // the street style: solid below zoom 4, then two widths on, one off
  pen.setLineDash(o.level >= 4 ? [2 * width, width] : []);
  pen.stroke();
  pen.setLineDash([]);
  return stats;
}
