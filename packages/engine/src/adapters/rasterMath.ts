import type { Vec3 } from '@aio/schema';

export interface Corners {
  tl: Vec3;
  tr: Vec3;
  bl: Vec3;
}

/** Quad vertex positions tl, tr, br, bl (br = tr + bl - tl) for a raster placement. */
export function quadPositions(c: Corners): Float32Array {
  const br: Vec3 = [
    c.tr[0] + c.bl[0] - c.tl[0],
    c.tr[1] + c.bl[1] - c.tl[1],
    c.tr[2] + c.bl[2] - c.tl[2],
  ];
  return new Float32Array([...c.tl, ...c.tr, ...br, ...c.bl]);
}

/** UVs matching quadPositions with texture.flipY = true: tl (0,1), tr (1,1), br (1,0), bl (0,0). */
export const QUAD_UVS = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
/** Two triangles, counter-clockwise seen from above (+Y). */
export const QUAD_INDEX = [0, 3, 1, 1, 3, 2];

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

/** Validate a kit-pyramid `tiles.json` (data-conventions section 5). */
export function parseTileIndex(json: unknown): TileIndex {
  const j = json as {
    schema?: unknown;
    levels?: unknown;
    corners?: Partial<Record<string, unknown>>;
  };
  if (j.schema !== 'aio.tiles/1') throw new Error('Tile index is not aio.tiles/1');
  const c = j.corners;
  if (!c || !isVec3(c.tl) || !isVec3(c.tr) || !isVec3(c.bl))
    throw new Error('Tile index has no tl, tr, bl corners');
  if (!Array.isArray(j.levels) || j.levels.length === 0)
    throw new Error('Tile index has no levels');
  const levels = (j.levels as TileLevel[])
    .filter((l) => l.cols > 0 && l.rows > 0 && typeof l.pattern === 'string')
    .sort((a, b) => a.z - b.z);
  return { levels, corners: { tl: c.tl, tr: c.tr, bl: c.bl } };
}

function lerpCorner(c: Corners, u: number, v: number): Vec3 {
  return [
    c.tl[0] + u * (c.tr[0] - c.tl[0]) + v * (c.bl[0] - c.tl[0]),
    c.tl[1] + u * (c.tr[1] - c.tl[1]) + v * (c.bl[1] - c.tl[1]),
    c.tl[2] + u * (c.tr[2] - c.tl[2]) + v * (c.bl[2] - c.tl[2]),
  ];
}

/** Placement of tile (x, y) of a cols x rows grid; y counts down from the top edge. */
export function tileCorners(c: Corners, cols: number, rows: number, x: number, y: number): Corners {
  return {
    tl: lerpCorner(c, x / cols, y / rows),
    tr: lerpCorner(c, (x + 1) / cols, y / rows),
    bl: lerpCorner(c, x / cols, (y + 1) / rows),
  };
}

export const tileKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

export function tileUrl(pattern: string, z: number, x: number, y: number): string {
  return pattern.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

/** A fine level streams in when the camera is closer than this many tile widths. */
const ACTIVE_TILE_WIDTHS = 8;
const WANT_MAX = 9;
/** Loaded tiles beyond the wanted ones that stay (hysteresis). */
const KEEP_EXTRA = 3;

/**
 * The size an image is scaled to so neither edge exceeds `max` (aspect kept), or null when it
 * already fits. Low graphics presets keep textures small; the GPU limit caps every preset.
 */
export function fitTextureSize(
  width: number,
  height: number,
  max: number,
): [number, number] | null {
  if (!(max > 0) || (width <= max && height <= max)) return null;
  const k = max / Math.max(width, height);
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}

/**
 * Which tiles to load and drop for the current view. Port of the Al-Zour artifact's `orthoTick`:
 * the coarsest level is always resident; each finer level streams its nearest tiles around the
 * orbit target (at most `wantMax` wanted, 3 more kept; 9 and 12 by default) and releases them
 * with hysteresis. The graphics preset lowers `wantMax` on integrated graphics.
 */
export function planTiles(
  index: TileIndex,
  target: Vec3,
  distance: number,
  loaded: ReadonlySet<string>,
  wantMax = WANT_MAX,
): { load: string[]; drop: string[] } {
  const keepMax = wantMax + KEEP_EXTRA;
  const load: string[] = [];
  const keep = new Set<string>();
  const { corners } = index;
  const width = Math.hypot(corners.tr[0] - corners.tl[0], corners.tr[2] - corners.tl[2]);

  index.levels.forEach((level, li) => {
    if (li === 0) {
      for (let y = 0; y < level.rows; y++)
        for (let x = 0; x < level.cols; x++) {
          const k = tileKey(level.z, x, y);
          keep.add(k);
          if (!loaded.has(k)) load.push(k);
        }
      return;
    }
    const s = width / level.cols;
    if (distance > s * ACTIVE_TILE_WIDTHS) return;
    const r = Math.max(s, distance * 0.9);
    const near: { k: string; dd: number }[] = [];
    for (let y = 0; y < level.rows; y++)
      for (let x = 0; x < level.cols; x++) {
        const c = lerpCorner(corners, (x + 0.5) / level.cols, (y + 0.5) / level.rows);
        near.push({
          k: tileKey(level.z, x, y),
          dd: Math.hypot(c[0] - target[0], c[2] - target[2]),
        });
      }
    near.sort((a, b) => a.dd - b.dd);
    near.forEach(({ k, dd }, rank) => {
      const want = dd < r + s * 0.5 && rank < wantMax;
      if (want) {
        keep.add(k);
        if (!loaded.has(k)) load.push(k);
      } else if (loaded.has(k) && !(dd > r * 1.6 + s || rank >= keepMax)) {
        keep.add(k); // hysteresis: keep a loaded tile until it is clearly out of range
      }
    });
  });

  const drop = [...loaded].filter((k) => !keep.has(k));
  return { load, drop };
}
