import type { MapPackInfo } from '@aio/schema';

/** An installed offline map pack (PMTiles), as listed by IPC `packs:list`. */
export type MapPack = MapPackInfo;

/** [west, south, east, north] in degrees. */
export type Bbox = [number, number, number, number];

const PACK_ID = /^[a-z0-9-]+$/;

function checkId(id: string): string {
  if (!PACK_ID.test(id)) throw new Error(`Invalid map pack id "${id}"`);
  return id;
}

/** aio:// URL of a pack file, served by the main process with range requests. */
export function packFileUrl(pack: Pick<MapPack, 'id'>): string {
  return `aio://packs/${checkId(pack.id)}.pmtiles`;
}

/** MapLibre `pmtiles://` source URL for a pack (single-pack styles). */
export function packUrl(pack: Pick<MapPack, 'id'>): string {
  return `pmtiles://${packFileUrl(pack)}`;
}

/** True when the point lies inside the pack bounding box. */
export function packCovers(pack: Pick<MapPack, 'bbox'>, lon: number, lat: number): boolean {
  const [w, s, e, n] = pack.bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

function area([w, s, e, n]: readonly number[]): number {
  return ((e ?? 0) - (w ?? 0)) * ((n ?? 0) - (s ?? 0));
}

/** Packs ordered most detailed first, then smallest area first. */
export function orderPacks<P extends Pick<MapPack, 'bbox' | 'maxZoom'>>(packs: readonly P[]): P[] {
  return [...packs].sort((a, b) => b.maxZoom - a.maxZoom || area(a.bbox) - area(b.bbox));
}

function intersects(a: readonly number[], b: readonly number[]): boolean {
  const [aw = 0, as = 0, ae = 0, an = 0] = a;
  const [bw = 0, bs = 0, be = 0, bn = 0] = b;
  return aw < be && ae > bw && as < bn && an > bs;
}

function isGlobal(bbox: readonly number[]): boolean {
  const [w = 0, s = 0, e = 0, n = 0] = bbox;
  return w <= -179.9 && e >= 179.9 && s <= -84 && n >= 84;
}

/**
 * Packs to try, in order, for one tile of the merged basemap source. Up to the global pack's
 * maxZoom the global pack goes first (its tiles are complete, never clipped at a regional edge);
 * above it only regional packs that reach that zoom and touch the tile are tried.
 */
export function packsForTile<P extends Pick<MapPack, 'bbox' | 'maxZoom'>>(
  ordered: readonly P[],
  z: number,
  x: number,
  y: number,
): P[] {
  const tb = tileBbox(z, x, y);
  const candidates = ordered.filter((p) => z <= p.maxZoom && intersects(p.bbox, tb));
  const global = candidates.filter((p) => isGlobal(p.bbox));
  const regional = candidates.filter((p) => !isGlobal(p.bbox));
  return [...global, ...regional];
}

/** Web Mercator tile bounds [west, south, east, north] in degrees. */
export function tileBbox(z: number, x: number, y: number): Bbox {
  const n = 2 ** z;
  const lon = (tx: number) => (tx / n) * 360 - 180;
  const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** Bounding box of [lon, lat] points, or null for none. */
export function bboxOf(points: Iterable<readonly [number, number]>): Bbox | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of points) {
    w = Math.min(w, lon);
    e = Math.max(e, lon);
    s = Math.min(s, lat);
    n = Math.max(n, lat);
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** Mercator y in [0, 1] (0 at the north edge). */
function mercY(lat: number): number {
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, lat));
  const r = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

/** MapLibre zoom (512 px tiles) at which a bbox fits a width x height viewport. */
export function zoomForBbox(
  [w, s, e, n]: Bbox,
  width: number,
  height: number,
  { padding = 0, maxZoom = 22 }: { padding?: number; maxZoom?: number } = {},
): number {
  const fx = (e - w) / 360;
  const fy = Math.abs(mercY(s) - mercY(n));
  const zx = fx > 0 ? Math.log2(Math.max(1, width - 2 * padding) / (512 * fx)) : Infinity;
  const zy = fy > 0 ? Math.log2(Math.max(1, height - 2 * padding) / (512 * fy)) : Infinity;
  return Math.max(0, Math.min(maxZoom, zx, zy));
}
