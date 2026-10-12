/**
 * A project's kit pyramid (an ortho, a shaded DSM, a change heat map) as a CesiumJS imagery
 * provider (design approach A). CesiumJS asks for geographic tiles; each is drawn on a 256 px
 * canvas from the pyramid tiles under it, every pyramid tile with its own affine map from the
 * placement (`pyramidPlacement` is a fine grid, so one map per pyramid tile follows it within a
 * fraction of a pixel). Pyramid tiles are read through `fetchTile` and kept decoded in a small LRU.
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
  private readonly cache = new Map<string, Cached>();
  private decoded = 0;
  private lastError: string | null = null;
  private disposed = false;

  constructor(
    private readonly index: PyramidIndex,
    private readonly placement: PyramidPlacement,
    private readonly fetchTile: (path: string) => Promise<ImageBitmap>,
    private readonly o: { cacheTiles: number },
  ) {
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
        const entry = this.take(tile.path);
        try {
          const bitmap = await entry.bitmap;
          if (this.disposed) return;
          ctx.setTransform(...this.transformOf(tile, rect));
          ctx.drawImage(bitmap, 0, 0, 1, 1);
        } catch (err) {
          this.lastError = messageOf(err);
        } finally {
          this.release(entry);
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

  /** A pyramid tile from the LRU (read and decoded when missing), held until `release`. */
  private take(path: string): Cached {
    let entry = this.cache.get(path);
    if (entry) {
      // most recently used goes last
      this.cache.delete(path);
      this.cache.set(path, entry);
    } else {
      let read: Promise<ImageBitmap>;
      try {
        read = this.fetchTile(path);
      } catch (err) {
        read = Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      const created: Cached = { bitmap: read, decoded: null, users: 0 };
      created.bitmap = read.then(
        (bitmap) => {
          if (this.disposed || this.cache.get(path) !== created) bitmap.close();
          else {
            created.decoded = bitmap;
            this.decoded++;
          }
          return bitmap;
        },
        (err: unknown) => {
          // not kept: a later request reads it again
          if (this.cache.get(path) === created) this.cache.delete(path);
          throw err;
        },
      );
      this.cache.set(path, created);
      entry = created;
    }
    entry.users++;
    return entry;
  }

  private release(entry: Cached): void {
    entry.users--;
    this.trim();
  }

  /** Drop the least recently used tiles nobody is drawing while there are more than allowed. */
  private trim(): void {
    let over = this.cache.size - this.o.cacheTiles;
    for (const [path, entry] of this.cache) {
      if (over <= 0) break;
      if (entry.users > 0) continue;
      this.cache.delete(path);
      entry.decoded?.close();
      over--;
    }
  }

  /** Pyramid tiles decoded so far and the last read or draw that failed. */
  stats(): { tiles: number; lastError: string | null } {
    return { tiles: this.decoded, lastError: this.lastError };
  }

  /** Close every decoded tile; tiles still being read are closed when they arrive. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.cache.values()) entry.decoded?.close();
    this.cache.clear();
  }
}

/** The provider as the type CesiumJS's `ImageryLayer` takes (an interface it duck-types). */
export const asRasterProvider = (p: KitPyramidImageryProvider) => p as unknown as ImageryProvider;
