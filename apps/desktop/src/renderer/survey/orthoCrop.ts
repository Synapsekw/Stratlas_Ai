/**
 * A square crop of an ortho layer around a click, for **Suggest boundaries** (M11 G12, ADR 0011):
 * composed from the layer's own image or tiles (never the map or 3D canvas, so measurements and
 * labels drawn on top never reach the model), north up, `size` pixels a side, placed in the
 * project CRS by its left easting `x0`, top northing `y1` and pixel size `res`.
 *
 * Rasters are placed in the local frame (data-conventions section 5): x east, z south, a pure
 * translation of the project CRS by the manifest origin. Each image or tile is drawn into the
 * crop with the affine that maps its pixels to the crop's.
 */
import type { Layer, Vec3 } from '@aio/schema';

export type RasterLayer = Extract<Layer, { kind: 'raster' }>;

/** Raster formats the crop can read (the browser decodes their images). */
export const CROP_FORMATS: readonly string[] = ['kit-pyramid', 'image'];

export interface Corners {
  tl: Vec3;
  tr: Vec3;
  bl: Vec3;
}

export interface CropWindow {
  /** Project CRS easting of the left edge and northing of the top edge. */
  x0: number;
  y1: number;
  /** Ground size of one pixel. */
  res: number;
  size: number;
}

/** The crop of `sideM` metres around a point, `size` pixels a side. */
export function cropWindow(at: readonly [number, number], sideM: number, size = 1024): CropWindow {
  return { x0: at[0] - sideM / 2, y1: at[1] + sideM / 2, res: sideM / size, size };
}

/** A name for a crop: equal names are equal pixels (layer and window, to the millimetre). */
export function cropKey(layerId: string, w: CropWindow): string {
  const mm = (v: number) => Math.round(v * 1000).toString();
  return `${layerId}@${mm(w.x0)},${mm(w.y1)},${mm(w.res * w.size)},${String(w.size)}`;
}

/**
 * The canvas transform (`setTransform(a, b, c, d, e, f)`) that draws an image of `width` x
 * `height` pixels placed at `corners` (local frame) into the crop; `origin` is the manifest
 * origin (project CRS).
 */
export function drawTransform(
  corners: Corners,
  width: number,
  height: number,
  w: CropWindow,
  origin: Vec3,
): [number, number, number, number, number, number] {
  // the crop's top-left corner in the local frame
  const lx0 = w.x0 - origin[0];
  const lz0 = origin[1] - w.y1;
  const { tl, tr, bl } = corners;
  return [
    (tr[0] - tl[0]) / width / w.res,
    (tr[2] - tl[2]) / width / w.res,
    (bl[0] - tl[0]) / height / w.res,
    (bl[2] - tl[2]) / height / w.res,
    (tl[0] - lx0) / w.res,
    (tl[2] - lz0) / w.res,
  ];
}

/** Where a local point (x, z) falls on a placement, as fractions (u right, v down) of it. */
export function placementUv(corners: Corners, x: number, z: number): [number, number] {
  const { tl, tr, bl } = corners;
  const ax = tr[0] - tl[0];
  const az = tr[2] - tl[2];
  const bx = bl[0] - tl[0];
  const bz = bl[2] - tl[2];
  const det = ax * bz - az * bx;
  if (det === 0) return [Number.NaN, Number.NaN];
  const dx = x - tl[0];
  const dz = z - tl[2];
  return [(dx * bz - dz * bx) / det, (ax * dz - az * dx) / det];
}

/** The crop's four corners as fractions of a placement. */
function windowUv(corners: Corners, w: CropWindow, origin: Vec3): [number, number][] {
  const lx0 = w.x0 - origin[0];
  const lz0 = origin[1] - w.y1;
  const s = w.res * w.size;
  return [
    [lx0, lz0],
    [lx0 + s, lz0],
    [lx0, lz0 + s],
    [lx0 + s, lz0 + s],
  ].map(([x = 0, z = 0]) => placementUv(corners, x, z));
}

/** Whether the crop overlaps a placement at all. */
export function overlaps(corners: Corners, w: CropWindow, origin: Vec3): boolean {
  const uv = windowUv(corners, w, origin);
  const us = uv.map((p) => p[0]);
  const vs = uv.map((p) => p[1]);
  return Math.max(...us) > 0 && Math.min(...us) < 1 && Math.max(...vs) > 0 && Math.min(...vs) < 1;
}

/** Whether a project CRS point lies on a placement. */
export function covers(corners: Corners, at: readonly [number, number], origin: Vec3): boolean {
  const [u, v] = placementUv(corners, at[0] - origin[0], origin[1] - at[1]);
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

export interface TileLevel {
  z: number;
  tileSize: number;
  cols: number;
  rows: number;
  pattern: string;
}

export interface TileIndex {
  levels: TileLevel[];
  corners: Corners;
}

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');

/** A kit-pyramid `tiles.json` (`aio.tiles/1`), or null when it is not one. */
export function parseTiles(json: unknown): TileIndex | null {
  const j = json as { schema?: unknown; levels?: unknown; corners?: Record<string, unknown> };
  const c = j.corners;
  if (j.schema !== 'aio.tiles/1' || !c || !isVec3(c.tl) || !isVec3(c.tr) || !isVec3(c.bl))
    return null;
  if (!Array.isArray(j.levels)) return null;
  const levels = (j.levels as TileLevel[])
    .filter((l) => l.cols > 0 && l.rows > 0 && l.tileSize > 0 && typeof l.pattern === 'string')
    .sort((a, b) => a.z - b.z);
  return levels.length ? { levels, corners: { tl: c.tl, tr: c.tr, bl: c.bl } } : null;
}

/** Ground size of a level's pixel (along the top edge). */
export function levelRes(index: TileIndex, l: TileLevel): number {
  const { tl, tr } = index.corners;
  return Math.hypot(tr[0] - tl[0], tr[2] - tl[2]) / (l.cols * l.tileSize);
}

export interface TileRef {
  level: TileLevel;
  x: number;
  y: number;
  corners: Corners;
  path: string;
}

const lerp = (c: Corners, u: number, v: number): Vec3 => [
  c.tl[0] + u * (c.tr[0] - c.tl[0]) + v * (c.bl[0] - c.tl[0]),
  c.tl[1] + u * (c.tr[1] - c.tl[1]) + v * (c.bl[1] - c.tl[1]),
  c.tl[2] + u * (c.tr[2] - c.tl[2]) + v * (c.bl[2] - c.tl[2]),
];

/**
 * The tiles that cover the crop at the coarsest level still as sharp as the crop (its pixel at
 * most the crop's), or the finest level there is; never more than `maxTiles` (a coarser level
 * then).
 */
export function tilesFor(index: TileIndex, w: CropWindow, origin: Vec3, maxTiles = 64): TileRef[] {
  const uv = windowUv(index.corners, w, origin);
  const u0 = Math.max(0, Math.min(...uv.map((p) => p[0])));
  const u1 = Math.min(1, Math.max(...uv.map((p) => p[0])));
  const v0 = Math.max(0, Math.min(...uv.map((p) => p[1])));
  const v1 = Math.min(1, Math.max(...uv.map((p) => p[1])));
  if (!(u1 > u0 && v1 > v0)) return [];
  // coarse to fine; start at the coarsest level as sharp as the crop, or the finest there is
  const levels = [...index.levels].sort((p, q) => levelRes(index, q) - levelRes(index, p));
  let i = levels.findIndex((l) => levelRes(index, l) <= w.res * 1.0001);
  if (i < 0) i = levels.length - 1;
  for (; i >= 0; i--) {
    const level = levels[i];
    if (!level) continue;
    const xa = Math.floor(u0 * level.cols);
    const xb = Math.min(level.cols - 1, Math.ceil(u1 * level.cols) - 1);
    const ya = Math.floor(v0 * level.rows);
    const yb = Math.min(level.rows - 1, Math.ceil(v1 * level.rows) - 1);
    if ((xb - xa + 1) * (yb - ya + 1) > maxTiles && i > 0) continue;
    const out: TileRef[] = [];
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        out.push({
          level,
          x,
          y,
          corners: {
            tl: lerp(index.corners, x / level.cols, y / level.rows),
            tr: lerp(index.corners, (x + 1) / level.cols, y / level.rows),
            bl: lerp(index.corners, x / level.cols, (y + 1) / level.rows),
          },
          path: level.pattern
            .replace('{z}', String(level.z))
            .replace('{x}', String(x))
            .replace('{y}', String(y)),
        });
      }
    }
    return out;
  }
  return [];
}

/** What composing needs from the page (tests stand in for it). */
export interface CropIo {
  /** The URL of a project path or asset. */
  url(ref: RasterLayer['src']): string;
  fetchJson(url: string): Promise<unknown>;
  /** A decoded image, or null when it cannot be read (a missing tile). */
  image(url: string): Promise<{ width: number; height: number; source: CanvasImageSource } | null>;
  canvas(size: number): {
    ctx: Pick<
      OffscreenCanvasRenderingContext2D,
      | 'setTransform'
      | 'drawImage'
      | 'getImageData'
      | 'fillRect'
      | 'fillStyle'
      | 'imageSmoothingQuality'
    >;
  };
}

/** The placement of a layer's whole image (`image`) or pyramid (`kit-pyramid`), or null. */
export async function layerCorners(layer: RasterLayer, io: CropIo): Promise<Corners | null> {
  if (layer.format === 'image') return layer.corners ?? null;
  if (layer.format !== 'kit-pyramid') return null;
  return parseTiles(await io.fetchJson(io.url(layer.src)))?.corners ?? null;
}

/**
 * The crop's RGB bytes (`size` x `size` x 3, row 0 north; black where the layer has no image), or
 * a reason it cannot be made.
 */
export async function composeCrop(
  layer: RasterLayer,
  w: CropWindow,
  origin: Vec3,
  io: CropIo,
): Promise<{ ok: true; rgb: Uint8Array<ArrayBuffer> } | { ok: false; error: string }> {
  if (!CROP_FORMATS.includes(layer.format)) {
    return {
      ok: false,
      error: `Suggest boundaries reads tiled and image orthos; "${layer.name}" is a ${layer.format} raster.`,
    };
  }
  const { ctx } = io.canvas(w.size);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w.size, w.size);
  ctx.imageSmoothingQuality = 'high';
  const draw = async (url: string, corners: Corners) => {
    const img = await io.image(url);
    if (!img) return false;
    ctx.setTransform(...drawTransform(corners, img.width, img.height, w, origin));
    ctx.drawImage(img.source, 0, 0);
    return true;
  };
  if (layer.format === 'image') {
    if (!layer.corners) return { ok: false, error: `The ortho "${layer.name}" has no placement.` };
    if (!(await draw(io.url(layer.src), layer.corners))) {
      return { ok: false, error: `The ortho "${layer.name}" could not be read.` };
    }
  } else {
    const index = parseTiles(await io.fetchJson(io.url(layer.src)));
    if (!index) return { ok: false, error: `The ortho "${layer.name}" has no valid tile index.` };
    const tiles = tilesFor(index, w, origin);
    if (!tiles.length) return { ok: false, error: 'The click is outside the ortho.' };
    const drawn = await Promise.all(tiles.map((t) => draw(io.url({ path: t.path }), t.corners)));
    if (!drawn.some(Boolean))
      return { ok: false, error: `The tiles of "${layer.name}" could not be read.` };
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const rgba = ctx.getImageData(0, 0, w.size, w.size).data;
  const rgb = new Uint8Array(w.size * w.size * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i] ?? 0;
    rgb[j + 1] = rgba[i + 1] ?? 0;
    rgb[j + 2] = rgba[i + 2] ?? 0;
  }
  return { ok: true, rgb };
}

/** The page's own fetch, image decoding and an offscreen canvas. */
export const browserCropIo = (url: (ref: RasterLayer['src']) => string): CropIo => ({
  url,
  async fetchJson(u) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u}: ${String(r.status)}`);
    return (await r.json()) as unknown;
  },
  async image(u) {
    try {
      const r = await fetch(u);
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      return { width: bmp.width, height: bmp.height, source: bmp };
    } catch {
      return null;
    }
  },
  canvas(size) {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D canvas');
    return { ctx };
  },
});
