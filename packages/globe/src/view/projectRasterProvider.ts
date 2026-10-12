/**
 * A project's kit pyramid (an ortho, a shaded DSM, a change heat map) as a CesiumJS imagery
 * provider (design approach A). CesiumJS asks for geographic tiles; each is drawn on a 256 px
 * canvas from the pyramid tiles under it, every pyramid tile with its own affine map from the
 * placement (`pyramidPlacement` is a fine grid, so one map per pyramid tile follows it within a
 * fraction of a pixel). Pyramid tiles are read through `fetchTile` and kept decoded in an LRU that
 * every raster of a Globe shares (`DecodedTileCache`), so the budget caps them all together.
 * Nothing here throws into CesiumJS: a missing or failing tile leaves its part transparent.
 */
import { Event, Math as CMath, Rectangle } from '@cesium/core';
import { GeographicTilingScheme, type Credit, type ImageryProvider } from '@cesium/engine';
import {
  pyramidTilesFor,
  type PyramidIndex,
  type PyramidPlacement,
  type PyramidTileRef,
} from '../projectRasters';

const TILE_PX = 256;
/** Metres of ground per degree of latitude (the rule `requestImage` sizes a tile's pixel by). */
const METRES_PER_DEGREE = 111_320;
const MAX_LEVEL = 22;

/** Ground metres of one pixel of a geographic tile of `level` (its height in degrees, 256 px). */
const levelMetresPerPx = (level: number): number =>
  ((180 / 2 ** level) * METRES_PER_DEGREE) / TILE_PX;

/** A transparent tile, where the pyramid is not. */
let empty: HTMLCanvasElement | undefined;
function emptyTile(): HTMLCanvasElement {
  empty ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
  return empty;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Cached {
  bitmap: Promise<ImageBitmap>;
  /** Set once decoded: what `close()` is called on. */
  decoded: ImageBitmap | null;
  /** Requests drawing it now: it is not dropped while in use. */
  users: number;
  /** The raster it belongs to (`dropOwner` closes a raster's tiles). */
  owner: number;
}

/**
 * Decoded pyramid tiles of every raster of one Globe, least recently used first, at most `budget`
 * in all (tiles being drawn are kept over it until released). Keys carry the raster, so two
 * rasters never share a bitmap by path. A dropped tile is closed; a read that arrives after its
 * tile was dropped is closed on arrival.
 */
export class DecodedTileCache {
  private readonly entries = new Map<string, Cached>();
  private nextOwner = 0;

  constructor(readonly budget: number) {}

  /** Tiles held, decoded or still being read. */
  get size(): number {
    return this.entries.size;
  }

  /** A fresh raster identity for the keys. */
  owner(): number {
    return this.nextOwner++;
  }

  /** A tile (read and decoded when missing), held until `release`. */
  take(
    owner: number,
    path: string,
    fetchTile: (path: string) => Promise<ImageBitmap>,
    onDecoded: () => void,
  ): Cached {
    const key = `${owner}:${path}`;
    let entry = this.entries.get(key);
    if (entry) {
      // most recently used goes last
      this.entries.delete(key);
      this.entries.set(key, entry);
    } else {
      let read: Promise<ImageBitmap>;
      try {
        read = fetchTile(path);
      } catch (err) {
        read = Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      const created: Cached = { bitmap: read, decoded: null, users: 0, owner };
      created.bitmap = read.then(
        (bitmap) => {
          if (this.entries.get(key) !== created) bitmap.close();
          else {
            created.decoded = bitmap;
            onDecoded();
          }
          return bitmap;
        },
        (err: unknown) => {
          // not kept: a later request reads it again
          if (this.entries.get(key) === created) this.entries.delete(key);
          throw err;
        },
      );
      this.entries.set(key, created);
      entry = created;
    }
    entry.users++;
    return entry;
  }

  release(entry: Cached): void {
    entry.users--;
    this.trim();
  }

  /** Close and forget every tile of a raster; its reads still in flight are closed on arrival. */
  dropOwner(owner: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.owner !== owner) continue;
      this.entries.delete(key);
      entry.decoded?.close();
    }
  }

  /** Drop the least recently used tiles nobody is drawing while there are more than allowed. */
  private trim(): void {
    let over = this.entries.size - this.budget;
    for (const [key, entry] of this.entries) {
      if (over <= 0) break;
      if (entry.users > 0) continue;
      this.entries.delete(key);
      entry.decoded?.close();
      over--;
    }
  }
}

export class KitPyramidImageryProvider {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly tileWidth = TILE_PX;
  readonly tileHeight = TILE_PX;
  readonly minimumLevel = 0;
  readonly maximumLevel: number;
  readonly rectangle: Rectangle;
  readonly errorEvent = new Event();
  readonly ready = true;
  readonly credit: Credit | undefined = undefined;
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;
  readonly tileDiscardPolicy = undefined;
  private readonly cache: DecodedTileCache;
  private readonly owner: number;
  private decoded = 0;
  private lastError: string | null = null;
  private disposed = false;

  constructor(
    private readonly index: PyramidIndex,
    private readonly placement: PyramidPlacement,
    private readonly fetchTile: (path: string) => Promise<ImageBitmap>,
    private readonly o: {
      cacheTiles: number;
      /** The Globe's shared cache; a cache of `cacheTiles` of its own when left out. */
      cache?: DecodedTileCache;
    },
  ) {
    this.cache = o.cache ?? new DecodedTileCache(o.cacheTiles);
    this.owner = this.cache.owner();
    const [west, south, east, north] = placement.rect;
    this.rectangle = Rectangle.fromDegrees(
      Math.max(west, -180),
      Math.max(south, -90),
      Math.min(east, 180),
      Math.min(north, 90),
    );
    const finest = placement.metresPerPx.at(-1) ?? Infinity;
    let level = 0;
    while (level < MAX_LEVEL && levelMetresPerPx(level) > finest) level++;
    this.maximumLevel = level;
  }

  getTileCredits(): Credit[] | undefined {
    return undefined;
  }

  pickFeatures(): undefined {
    return undefined;
  }

  requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    return this.draw(x, y, level).catch((err: unknown) => {
      this.lastError = messageOf(err);
      return emptyTile();
    });
  }

  private async draw(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    if (this.disposed) return emptyTile();
    const r = this.tilingScheme.tileXYToRectangle(x, y, level);
    const rect: [number, number, number, number] = [
      CMath.toDegrees(r.west),
      CMath.toDegrees(r.south),
      CMath.toDegrees(r.east),
      CMath.toDegrees(r.north),
    ];
    const [pw, ps, pe, pn] = this.placement.rect;
    if (rect[2] <= pw || rect[0] >= pe || rect[3] <= ps || rect[1] >= pn) return emptyTile();
    const metresPerPx = ((rect[3] - rect[1]) * METRES_PER_DEGREE) / TILE_PX;
    const cover = pyramidTilesFor(
      this.index,
      this.placement,
      rect,
      metresPerPx,
      Math.min(16, Math.max(1, this.o.cacheTiles)),
    );
    if (!cover) return emptyTile();

    const canvas = Object.assign(document.createElement('canvas'), {
      width: TILE_PX,
      height: TILE_PX,
    });
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas to draw project rasters');
    await Promise.all(
      cover.tiles.map(async (tile) => {
        const entry = this.cache.take(this.owner, tile.path, this.fetchTile, () => {
          if (!this.disposed) this.decoded++;
        });
        try {
          const bitmap = await entry.bitmap;
          if (this.disposed) return;
          ctx.setTransform(...this.transformOf(tile, rect));
          ctx.drawImage(bitmap, 0, 0, 1, 1);
        } catch (err) {
          this.lastError = messageOf(err);
        } finally {
          this.cache.release(entry);
        }
      }),
    );
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  /**
   * The canvas transform that takes the unit square of a pyramid tile's bitmap to its place on
   * the canvas of the geographic tile `rect`: the tile's own corners through the placement, so
   * each pyramid tile follows the placement's grid on its own.
   */
  private transformOf(
    tile: PyramidTileRef,
    [west, south, east, north]: [number, number, number, number],
  ): [number, number, number, number, number, number] {
    const px = (u: number, v: number): [number, number] => {
      const [lon, lat] = this.placement.toLonLat(u, v);
      return [
        ((lon - west) / (east - west)) * TILE_PX,
        ((north - lat) / (north - south)) * TILE_PX,
      ];
    };
    const [x00, y00] = px(tile.u0, tile.v0);
    const [x10, y10] = px(tile.u1, tile.v0);
    const [x01, y01] = px(tile.u0, tile.v1);
    return [x10 - x00, y10 - y00, x01 - x00, y01 - y00, x00, y00];
  }

  /**
   * Pyramid tiles decoded since the provider was made (every decode counts, including tiles read
   * again after the LRU dropped them), and the last read or draw that failed.
   */
  stats(): { tiles: number; lastError: string | null } {
    return { tiles: this.decoded, lastError: this.lastError };
  }

  /** Close this raster's decoded tiles; its tiles still being read are closed when they arrive. */
  dispose(): void {
    this.disposed = true;
    this.cache.dropOwner(this.owner);
  }
}

/** The provider as the type CesiumJS's `ImageryLayer` takes (an interface it duck-types). */
export const asRasterProvider = (p: KitPyramidImageryProvider) => p as unknown as ImageryProvider;
