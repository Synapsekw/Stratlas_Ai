/**
 * Imagery and terrain from the app's raster packs (decision 4, data-conventions section 23):
 * CesiumJS reads neither PMTiles nor Terrarium, so a small imagery provider reads raster PMTiles
 * tiles and a heightmap provider samples Terrarium tiles onto CesiumJS's geographic heightmap
 * tiles with the geoid separation added. Both read through a pmtiles `Source` (by default the
 * pack's `aio://` URL, range requests), and nothing else.
 */
import { Event, Rectangle } from '@cesium/core';
import {
  Credit,
  CustomHeightmapTerrainProvider,
  GeographicTilingScheme,
  WebMercatorTilingScheme,
  type ImageryProvider,
  type TerrainProvider,
} from '@cesium/engine';
import type { RasterPackInfo } from '@aio/schema';
import { PMTiles, type Source } from 'pmtiles';
import {
  decodeTerrarium,
  geoidFor,
  heightFromTiles,
  heightmapFor,
  NO_GEOID,
  terrainZoom,
  tilesForRect,
  type Geoid,
  type HeightGrid,
} from '../terrarium';
import { orderRasterPacks, type BBox } from '../tiles';

type PackInfo = Pick<
  RasterPackInfo,
  | 'id'
  | 'kind'
  | 'bbox'
  | 'minZoom'
  | 'maxZoom'
  | 'tileSize'
  | 'format'
  | 'attribution'
  | 'customerLicence'
  | 'verticalDatum'
>;

const MIME: Record<RasterPackInfo['format'], string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
};

const DEG = Math.PI / 180;
const rectangleOf = (b: BBox) =>
  Rectangle.fromDegrees(
    Math.max(b[0], -180),
    Math.max(b[1], -90),
    Math.min(b[2], 180),
    Math.min(b[3], 90),
  );

/** A transparent tile, where a pack has no tile in its own bounds. */
let empty: HTMLCanvasElement | undefined;
function emptyTile(): HTMLCanvasElement {
  empty ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
  return empty;
}

/** Decode encoded tile bytes to an image Cesium uploads as it does its own (blob URL, no network). */
async function decodeImage(data: ArrayBuffer, mime: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The credit line of a pack: its attribution, marked when it is the customer's own imagery. */
export const packCredit = (p: Pick<PackInfo, 'attribution' | 'customerLicence'>) =>
  p.customerLicence ? `${p.attribution} (customer licence)` : p.attribution;

/**
 * An imagery pack (raster PMTiles, Web Mercator) as a CesiumJS imagery provider. Tiles above the
 * pack's `maxZoom` are drawn from its deepest tiles by CesiumJS; outside its bounds nothing is
 * requested.
 */
export class PmtilesImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly minimumLevel: number;
  readonly maximumLevel: number;
  readonly rectangle: Rectangle;
  readonly errorEvent = new Event();
  readonly credit: Credit;
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;
  readonly tileDiscardPolicy = undefined;
  /** Tiles decoded so far (for the inspection hook and tests). */
  tilesLoaded = 0;
  private readonly archive: PMTiles;
  private readonly mime: string;

  constructor(
    readonly pack: PackInfo,
    source: Source,
  ) {
    this.archive = new PMTiles(source);
    this.tileWidth = pack.tileSize;
    this.tileHeight = pack.tileSize;
    this.minimumLevel = pack.minZoom;
    this.maximumLevel = pack.maxZoom;
    this.rectangle = rectangleOf(pack.bbox);
    this.credit = new Credit(packCredit(pack));
    this.mime = MIME[pack.format];
  }

  getTileCredits(): Credit[] | undefined {
    return undefined;
  }

  requestImage(x: number, y: number, level: number): Promise<HTMLImageElement | HTMLCanvasElement> {
    return this.archive.getZxy(level, x, y).then(async (tile) => {
      if (!tile) return emptyTile();
      const img = await decodeImage(tile.data, this.mime);
      this.tilesLoaded++;
      return img;
    });
  }

  pickFeatures(): undefined {
    return undefined;
  }
}

/** The provider as the type CesiumJS's `ImageryLayer` takes (an interface it duck-types). */
export const asImageryProvider = (p: PmtilesImageryProvider) => p as unknown as ImageryProvider;

/** Decode a Terrarium tile (lossless WebP or PNG) to heights, without colour management. */
async function decodeHeights(data: ArrayBuffer, mime: string): Promise<HeightGrid> {
  const bitmap = await createImageBitmap(new Blob([data], { type: mime }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D canvas to decode terrain tiles');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data: rgba } = ctx.getImageData(0, 0, canvas.width, canvas.height, {
    colorSpace: 'srgb',
  });
  return decodeTerrarium(rgba, canvas.width, canvas.height);
}

interface TerrainSource {
  pack: PackInfo;
  archive: PMTiles;
  mime: string;
  geoid: Geoid;
  tiles: Map<string, Promise<HeightGrid | null>>;
}

export interface PackTerrainOptions {
  packs: readonly PackInfo[];
  sourceFor: (pack: PackInfo) => Source;
  /** Geoid undulation, added to the heights of EGM packs (none bundled yet: 0). */
  geoid: Geoid;
  /** Heightmap samples per tile edge (CesiumJS uses 65 for its own heightmaps). */
  size?: number;
  /** Decoded tiles kept per pack. */
  cacheTiles?: number;
}

/**
 * Terrain packs as one CesiumJS terrain provider: geographic heightmap tiles (no holes at the
 * poles), each sample from the most detailed pack that covers it, heights above the ellipsoid.
 */
export function packTerrainProvider(o: PackTerrainOptions): TerrainProvider & {
  readonly tilesDecoded: () => number;
} {
  const size = o.size ?? 65;
  const keep = o.cacheTiles ?? 256;
  let decoded = 0;
  const sources: TerrainSource[] = orderRasterPacks(o.packs).map((pack) => ({
    pack,
    archive: new PMTiles(o.sourceFor(pack)),
    mime: MIME[pack.format],
    geoid: geoidFor(pack.verticalDatum, o.geoid),
    tiles: new Map(),
  }));
  const tilingScheme = new GeographicTilingScheme();

  const tile = (s: TerrainSource, z: number, x: number, y: number) => {
    const key = `${String(z)}/${String(x)}/${String(y)}`;
    let p = s.tiles.get(key);
    if (!p) {
      p = s.archive.getZxy(z, x, y).then(
        async (t) => {
          if (!t) return null;
          const g = await decodeHeights(t.data, s.mime);
          decoded++;
          return g;
        },
        () => null,
      );
      s.tiles.set(key, p);
      if (s.tiles.size > keep) {
        const oldest = s.tiles.keys().next().value;
        if (oldest !== undefined) s.tiles.delete(oldest);
      }
    }
    return p;
  };

  const provider = new CustomHeightmapTerrainProvider({
    width: size,
    height: size,
    tilingScheme,
    callback: async (x, y, level) => {
      const r = tilingScheme.tileXYToRectangle(x, y, level);
      const rect: BBox = [r.west / DEG, r.south / DEG, r.east / DEG, r.north / DEG];
      const touching = sources.filter(
        (s) =>
          s.pack.bbox[0] < rect[2] &&
          s.pack.bbox[2] > rect[0] &&
          s.pack.bbox[1] < rect[3] &&
          s.pack.bbox[3] > rect[1],
      );
      // per pack, the decoded tiles this heightmap needs, at a zoom near its resolution
      const loaded = await Promise.all(
        touching.map(async (s) => {
          const z = terrainZoom(level, rect, s.pack);
          const keys = tilesForRect(rect, z);
          const grids = await Promise.all(keys.map((k) => tile(s, k.z, k.x, k.y)));
          const byKey = new Map(keys.map((k, i) => [`${String(k.x)}/${String(k.y)}`, grids[i]]));
          return { s, z, byKey };
        }),
      );
      const heightAt = (lon: number, lat: number): number | null => {
        for (const { s, z, byKey } of loaded) {
          const b = s.pack.bbox;
          if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
          const h = heightFromTiles(
            lon,
            lat,
            z,
            (tx, ty) => byKey.get(`${String(tx)}/${String(ty)}`) ?? null,
          );
          if (h !== null) return h + s.geoid(lon, lat);
        }
        return null;
      };
      // outside every pack: the geoid surface (mean sea level), as the bundled terrain has none
      return heightmapFor(
        rect,
        size,
        (lon, lat) => heightAt(lon, lat) ?? o.geoid(lon, lat),
        NO_GEOID,
      );
    },
  });
  return Object.assign(provider, { tilesDecoded: () => decoded });
}
