import type { RasterPackInfo, RasterPackKind } from '@aio/schema';
import { FetchSource, PMTiles } from 'pmtiles';

/**
 * Imagery and terrain packs as tile providers, the same for every renderer (M10 G7, decision 4):
 * the site view's surroundings here, MapLibre's raster sources (`@aio/maps` `rasterPacks.ts`) and
 * the Globe's Cesium imagery and terrain providers (G6 wraps `RasterTileSource`).
 *
 * Packs are raster PMTiles served by main at `aio://packs/<kind>/<id>.pmtiles` (Web Mercator,
 * XYZ addressing). Where several packs cover a tile, the most detailed one that has it wins, the
 * same rule `orderPacks` applies to street packs.
 */

/** The slice of a PMTiles archive providers read (pmtiles `PMTiles.getZxy`). */
export interface RasterTileReader {
  getZxy(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<{ data: ArrayBuffer } | undefined>;
}

export type RasterPack = Pick<
  RasterPackInfo,
  'id' | 'kind' | 'bbox' | 'minZoom' | 'maxZoom' | 'attribution' | 'licence' | 'label'
> &
  Partial<Pick<RasterPackInfo, 'format' | 'tileSize' | 'encoding' | 'verticalDatum'>>;

const PACK_ID = /^[a-z0-9-]+$/;

/** `aio://packs/<kind>/<id>.pmtiles`, served by main with range requests. */
export function rasterPackUrl(
  pack: Pick<RasterPack, 'id' | 'kind'>,
  base = 'aio://packs/',
): string {
  if (!PACK_ID.test(pack.id)) throw new Error(`Invalid pack id "${pack.id}"`);
  return `${base}${pack.kind}/${pack.id}.pmtiles`;
}

/** A reader for one pack (pmtiles over fetch, range requests on `aio://`). */
export function openRasterPack(
  pack: Pick<RasterPack, 'id' | 'kind'>,
  base?: string,
): RasterTileReader {
  return new PMTiles(new FetchSource(rasterPackUrl(pack, base)));
}

function area([w, s, e, n]: readonly number[]): number {
  return ((e ?? 0) - (w ?? 0)) * ((n ?? 0) - (s ?? 0));
}

/** Most detailed first, then smallest area first. */
export function orderRasterPacks<P extends Pick<RasterPack, 'bbox' | 'maxZoom'>>(
  packs: readonly P[],
): P[] {
  return [...packs].sort((a, b) => b.maxZoom - a.maxZoom || area(a.bbox) - area(b.bbox));
}

/** Web Mercator tile bounds [west, south, east, north] in degrees. */
export function tileLonLatBounds(
  z: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (tx: number) => (tx / n) * 360 - 180;
  const lat = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** The packs that may hold a tile, best first (zoom in their range, bbox touching the tile). */
export function rasterPacksForTile<P extends Pick<RasterPack, 'bbox' | 'minZoom' | 'maxZoom'>>(
  ordered: readonly P[],
  z: number,
  x: number,
  y: number,
): P[] {
  const [tw, ts, te, tn] = tileLonLatBounds(z, x, y);
  return ordered.filter((p) => {
    const [w, s, e, n] = p.bbox;
    return z >= p.minZoom && z <= p.maxZoom && w < te && e > tw && s < tn && n > ts;
  });
}

/** One provider over many packs of a kind: the best covering tile, or undefined. */
export interface RasterTileSource {
  readonly kind: RasterPackKind;
  readonly packs: readonly RasterPack[];
  readonly minZoom: number;
  readonly maxZoom: number;
  /** The tile bytes (WebP, PNG or JPEG) and the pack they came from. */
  getTile(
    z: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<{ data: ArrayBuffer; pack: RasterPack } | undefined>;
  /** Attribution lines of the packs (each once), for the credits of a view. */
  credits(): string[];
}

export function createRasterTileSource(
  kind: RasterPackKind,
  packs: readonly RasterPack[],
  open: (pack: RasterPack) => RasterTileReader = (p) => openRasterPack(p),
): RasterTileSource {
  const own = orderRasterPacks(packs.filter((p) => p.kind === kind));
  const readers = new Map<string, RasterTileReader>();
  const reader = (p: RasterPack) => {
    let r = readers.get(p.id);
    if (!r) {
      r = open(p);
      readers.set(p.id, r);
    }
    return r;
  };
  return {
    kind,
    packs: own,
    minZoom: own.length ? Math.min(...own.map((p) => p.minZoom)) : 0,
    maxZoom: own.length ? Math.max(...own.map((p) => p.maxZoom)) : 0,
    async getTile(z, x, y, signal) {
      for (const p of rasterPacksForTile(own, z, x, y)) {
        const t = await reader(p).getZxy(z, x, y, signal);
        if (t && t.data.byteLength > 0) return { data: t.data, pack: p };
      }
      return undefined;
    },
    credits: () => rasterCredits(own),
  };
}

/** Attribution lines, each once, in pack order. */
export function rasterCredits(packs: readonly Pick<RasterPack, 'attribution'>[]): string[] {
  return [...new Set(packs.map((p) => p.attribution.trim()).filter(Boolean))];
}

/** Terrarium RGB(A) pixels to heights in metres (`R * 256 + G + B / 256 - 32768`). */
export function decodeTerrarium(rgba: ArrayLike<number>, channels = 4): Float32Array {
  const n = Math.floor(rgba.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    out[i] = (rgba[o] ?? 0) * 256 + (rgba[o + 1] ?? 0) + (rgba[o + 2] ?? 0) / 256 - 32768;
  }
  return out;
}

/** Longitude and latitude to fractional tile coordinates at a zoom. */
export function lonLatToTileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const clamped = Math.max(-85.0511287798066, Math.min(85.0511287798066, lat));
  const r = (clamped * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n];
}
