import type { Bbox } from './packs';

/** Web Mercator stops at this latitude. */
const MAX_LAT = 85.05;

function tileX(lon: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
}

function tileY(lat: number, n: number): number {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return Math.min(n - 1, Math.max(0, Math.floor(y)));
}

/** Number of z/x/y tiles a box touches at one zoom. */
export function tileCount([w, s, e, n]: Bbox, z: number): number {
  const size = 2 ** z;
  // The east edge on a tile boundary does not touch the next tile.
  const x0 = tileX(w, size);
  const x1 = Math.max(x0, tileX(e - 1e-9, size));
  const y0 = tileY(n, size);
  const y1 = Math.max(y0, tileY(s + 1e-9, size));
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

// Average bytes per tile fall with the zoom: A * R^z. Fitted to the world (z6), Kuwait (z15) and
// GCC (z15) packs of planet build 20261003; real sizes fall within 0.5x to 1.9x of the estimate
// (dense cities and coasts above it, desert and sea below).
const A = 39_500;
const R = 0.72;
const LOW = 0.5;
const HIGH = 1.9;

export interface PackEstimate {
  /** Best guess in bytes. */
  bytes: number;
  low: number;
  high: number;
  tiles: number;
}

/** Rough download size of a Protomaps extract of `bbox` from zoom 0 to `maxZoom`. */
export function estimatePackBytes(bbox: Bbox, maxZoom: number): PackEstimate {
  let bytes = 0;
  let tiles = 0;
  for (let z = 0; z <= maxZoom; z++) {
    const t = tileCount(bbox, z);
    tiles += t;
    bytes += t * A * R ** z;
  }
  return { bytes, low: bytes * LOW, high: bytes * HIGH, tiles };
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Order the corners of a drawn box, clamp it to the Web Mercator world and round it. */
export function normaliseBbox([a, b, c, d]: Bbox): Bbox {
  const clampLon = (v: number) => Math.max(-180, Math.min(180, v));
  const clampLat = (v: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, v));
  return [
    round4(clampLon(Math.min(a, c))),
    round4(clampLat(Math.min(b, d))),
    round4(clampLon(Math.max(a, c))),
    round4(clampLat(Math.max(b, d))),
  ];
}
