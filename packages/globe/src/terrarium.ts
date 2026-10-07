import type { TerrainDatum } from '@aio/schema';
import { lonLatToTileXY, type BBox } from './tiles';

/**
 * Terrain packs hold Terrarium-encoded heights (decision 4, data-conventions section 23):
 * `height = R * 256 + G + B / 256 - 32768` metres, lossless WebP or PNG tiles in Web Mercator.
 * The Globe samples them onto CesiumJS heightmap tiles in the geographic tiling scheme (so the
 * poles, outside Web Mercator, stay closed) and adds the geoid separation for packs whose heights
 * are above the geoid (EGM2008, EGM96), since CesiumJS wants heights above the WGS84 ellipsoid.
 */

export const terrariumHeight = (r: number, g: number, b: number): number =>
  r * 256 + g + b / 256 - 32768;

/** The Terrarium colour of a height (1/256 m steps), for synthetic packs and tests. */
export function encodeTerrarium(h: number): [number, number, number] {
  const v = Math.round((h + 32768) * 256);
  return [Math.floor(v / 65536) & 255, Math.floor(v / 256) & 255, v & 255];
}

/** Heights of one decoded tile, row-major from the north-west corner. */
export interface HeightGrid {
  width: number;
  height: number;
  values: Float32Array;
}

/** Decode RGBA pixels (canvas `ImageData` order) into heights. */
export function decodeTerrarium(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): HeightGrid {
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) {
    values[i] = terrariumHeight(rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0);
  }
  return { width, height, values };
}

/**
 * Bilinear height at a fractional pixel position (pixel centres at `i + 0.5`), clamped at the
 * edges of the grid.
 */
export function sampleGrid(g: HeightGrid, px: number, py: number): number {
  const x = Math.min(Math.max(px - 0.5, 0), g.width - 1);
  const y = Math.min(Math.max(py - 0.5, 0), g.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, g.width - 1);
  const y1 = Math.min(y0 + 1, g.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (i: number, j: number) => g.values[j * g.width + i] ?? 0;
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Geoid undulation N (metres above the ellipsoid) at a point, in degrees. */
export type Geoid = (lon: number, lat: number) => number;

/** No geoid model: heights are taken as they are (see {@link geoidFor}). */
export const NO_GEOID: Geoid = () => 0;

/**
 * A geoid model from a regular grid of undulations (for example NGA EGM2008 at 2.5' or 1°,
 * public domain), bilinear, rows from the north. Longitude wraps.
 */
export function gridGeoid(g: {
  west: number;
  north: number;
  stepDeg: number;
  cols: number;
  rows: number;
  values: ArrayLike<number>;
}): Geoid {
  return (lon, lat) => {
    let x = (lon - g.west) / g.stepDeg;
    x = ((x % g.cols) + g.cols) % g.cols;
    const y = Math.min(Math.max((g.north - lat) / g.stepDeg, 0), g.rows - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = (x0 + 1) % g.cols;
    const y1 = Math.min(y0 + 1, g.rows - 1);
    const fx = x - x0;
    const fy = y - y0;
    const at = (i: number, j: number) => g.values[j * g.cols + i] ?? 0;
    return (
      (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) +
      (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
    );
  };
}

/** What to add to a pack's heights to get ellipsoidal heights: the geoid for EGM packs. */
export function geoidFor(datum: TerrainDatum | undefined, geoid: Geoid): Geoid {
  return datum === 'ellipsoid' ? NO_GEOID : geoid;
}

/** A Web Mercator tile `z/x/y`. */
export interface TileKey {
  z: number;
  x: number;
  y: number;
}

/** The Web Mercator tiles at zoom `z` that a geographic rectangle touches. */
export function tilesForRect(rect: BBox, z: number): TileKey[] {
  const [x0, y0] = lonLatToTileXY(rect[0], rect[3], z);
  const [x1, y1] = lonLatToTileXY(rect[2], rect[1], z);
  const out: TileKey[] = [];
  for (let y = Math.floor(y0); y <= Math.floor(y1); y++)
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) out.push({ z, x, y });
  return out;
}

/**
 * The Web Mercator zoom to sample for a geographic heightmap tile at `level`: about as fine as the
 * heightmap's own spacing, within what the pack holds, and never more than `maxTiles` tiles.
 */
export function terrainZoom(
  level: number,
  rect: BBox,
  pack: { minZoom: number; maxZoom: number },
  maxTiles = 16,
): number {
  let z = Math.min(Math.max(level, pack.minZoom), pack.maxZoom);
  while (z > pack.minZoom && tilesForRect(rect, z).length > maxTiles) z--;
  return z;
}

/**
 * The heights of a `size` x `size` heightmap over `rect` (row-major from the north-west corner,
 * samples on the edges, as CesiumJS's `HeightmapTerrainData` wants them), from a height lookup
 * (null where there is no data: the geoid surface, mean sea level, stands in) plus the geoid.
 */
export function heightmapFor(
  rect: BBox,
  size: number,
  heightAt: (lon: number, lat: number) => number | null,
  geoid: Geoid,
): Float32Array {
  const out = new Float32Array(size * size);
  const [w, s, e, n] = rect;
  for (let j = 0; j < size; j++) {
    const lat = n - ((n - s) * j) / (size - 1);
    for (let i = 0; i < size; i++) {
      const lon = w + ((e - w) * i) / (size - 1);
      out[j * size + i] = (heightAt(lon, lat) ?? 0) + geoid(lon, lat);
    }
  }
  return out;
}

/** Height at a point from decoded tiles at zoom `z` (`tile(x, y)` null where none). */
export function heightFromTiles(
  lon: number,
  lat: number,
  z: number,
  tile: (x: number, y: number) => HeightGrid | null,
): number | null {
  const [fx, fy] = lonLatToTileXY(lon, lat, z);
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  const g = tile(x, y);
  if (!g) return null;
  return sampleGrid(g, (fx - x) * g.width, (fy - y) * g.height);
}
