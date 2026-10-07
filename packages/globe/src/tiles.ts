import type { RasterPackKind } from '@aio/schema';

/**
 * Web Mercator tile addressing for the raster packs (data-conventions section 23: imagery and
 * terrain packs are XYZ tiles in Web Mercator, y from the north, as MapLibre and Cesium's
 * `WebMercatorTilingScheme` count them), and the choice of packs the Globe draws.
 */

/** West, south, east, north in WGS84 degrees. */
export type BBox = readonly [number, number, number, number];

/** What the tile maths needs of a pack (`RasterPackInfo` has it). */
export interface PackExtent {
  readonly id: string;
  readonly bbox: BBox;
  readonly minZoom: number;
  readonly maxZoom: number;
}

/** The Web Mercator latitude limit (the square world of zoom 0). */
export const MERCATOR_MAX_LAT = 85.0511287798066;

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
};

/** The bounds of tile `z/x/y`. */
export function tileBounds(z: number, x: number, y: number): BBox {
  return [tileLon(x, z), tileLat(y + 1, z), tileLon(x + 1, z), tileLat(y, z)];
}

/** Fractional tile coordinates of a point at zoom `z` (the integer part is the tile). */
export function lonLatToTileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const r = (clamped * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [Math.min(Math.max(x, 0), n - 1e-9), Math.min(Math.max(y, 0), n - 1e-9)];
}

const intersects = (a: BBox, b: BBox) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const area = (b: BBox) => (b[2] - b[0]) * (b[3] - b[1]);

/** Whether a pack has data for tile `z/x/y` (deeper zooms use its tiles at `maxZoom`). */
export function packCovers(
  pack: Pick<PackExtent, 'bbox' | 'minZoom'>,
  z: number,
  x: number,
  y: number,
): boolean {
  return z >= pack.minZoom && intersects(pack.bbox, tileBounds(z, x, y));
}

/** Packs most detailed first, then smallest area first (the street maps' `orderPacks`). */
export function orderRasterPacks<P extends Pick<PackExtent, 'bbox' | 'maxZoom'>>(
  packs: readonly P[],
): P[] {
  return [...packs].sort((a, b) => b.maxZoom - a.maxZoom || area(a.bbox) - area(b.bbox));
}

/**
 * The imagery layers to draw, bottom first: the least detailed at the bottom, so the best
 * covering pack wins wherever it has tiles and the coarser ones show around it.
 */
export function imageryLayerOrder<P extends Pick<PackExtent, 'bbox' | 'maxZoom'>>(
  packs: readonly P[],
): P[] {
  return orderRasterPacks(packs).reverse();
}

/** The packs a Globe setting selects (`auto`: every installed pack; an id: that one only). */
export function selectPacks<P extends Pick<PackExtent, 'id'>>(
  packs: readonly P[],
  /** `GlobeSettings.imagery` or `.terrain`: `auto`, `off` or a pack id. */
  choice: string | undefined,
): P[] {
  if (choice === 'off') return [];
  if (choice === undefined || choice === 'auto') return [...packs];
  return packs.filter((p) => p.id === choice);
}

/** The best terrain pack for a point, or null outside every pack. */
export function packAt<P extends Pick<PackExtent, 'bbox' | 'maxZoom'>>(
  ordered: readonly P[],
  lon: number,
  lat: number,
): P | null {
  return (
    ordered.find(
      (p) => lon >= p.bbox[0] && lon <= p.bbox[2] && lat >= p.bbox[1] && lat <= p.bbox[3],
    ) ?? null
  );
}

/** Where the renderer reads a raster pack (`aio://packs/<kind>/<id>.pmtiles`, range requests). */
export function rasterPackUrl(kind: RasterPackKind, id: string): string {
  return `aio://packs/${kind}/${id}.pmtiles`;
}
