/**
 * The Earth of the street looks as CesiumJS imagery: the bundled land and border shapes painted
 * per tile on a 2D canvas (`earth/draw.ts`), and the host's street tiles (`GlobeTileSource`)
 * draped over them. Both are drawn in the app, from files the app ships or the person installed.
 */
import { Event } from '@cesium/core';
import {
  Credit,
  GeographicTilingScheme,
  WebMercatorTilingScheme,
  type ImageryProvider,
} from '@cesium/engine';
import { EARTH_SHAPES_CREDIT } from '../credits';
import { drawEarthTile, geographicTileBox, type EarthInk } from '../earth/draw';
import { parseEarth, type EarthShapes } from '../earth/shapes';
import { styleZoomFor, type GlobeTileSource } from '../layers';

let shapes: Promise<EarthShapes> | undefined;

/** The bundled land and borders, read and decoded once (its own lazily loaded chunk). */
export function loadEarthShapes(): Promise<EarthShapes> {
  shapes ??= import('world-atlas/countries-50m.json?raw').then((m) => parseEarth(m.default));
  return shapes;
}

export interface EarthImageryOptions {
  ink: EarthInk;
  /** Pixels along the edge of a tile's picture. */
  imagePx: number;
  /** Device pixels per CSS pixel the scene is drawn at. */
  pixelRatio: number;
  /** The deepest level painted; deeper, CesiumJS stretches the last one. */
  maximumLevel: number;
}

/**
 * The edge of an Earth tile in CSS pixels. CesiumJS picks levels by a tile's size in the pixels
 * it draws (device pixels), so both providers tell it this size times the scene's pixel ratio:
 * a tile then covers about its own size on screen, and a street label keeps its size.
 */
const EARTH_TILE_SIZE = 512;

/** The land and border shapes as imagery, a canvas per tile. */
export class EarthImageryProvider {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly minimumLevel = 0;
  readonly maximumLevel: number;
  readonly rectangle = this.tilingScheme.rectangle;
  readonly errorEvent = new Event();
  readonly credit = new Credit(EARTH_SHAPES_CREDIT);
  readonly proxy = undefined;
  readonly hasAlphaChannel = false;
  readonly tileDiscardPolicy = undefined;
  /** Tiles painted so far, and the milliseconds they took (the inspection hook). */
  tilesDrawn = 0;
  drawMs = 0;

  constructor(
    private readonly shapes: EarthShapes,
    private readonly o: EarthImageryOptions,
  ) {
    this.maximumLevel = o.maximumLevel;
    this.tileWidth = Math.round(EARTH_TILE_SIZE * o.pixelRatio);
    this.tileHeight = this.tileWidth;
  }

  getTileCredits(): Credit[] | undefined {
    return undefined;
  }

  requestImage(x: number, y: number, level: number): Promise<HTMLCanvasElement> {
    const t0 = performance.now();
    const size = this.o.imagePx;
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx)
      drawEarthTile(ctx, this.shapes, {
        box: geographicTileBox(level, x, y),
        level,
        size,
        scale: size / EARTH_TILE_SIZE,
        ink: this.o.ink,
      });
    this.tilesDrawn++;
    this.drawMs += performance.now() - t0;
    return Promise.resolve(canvas);
  }

  pickFeatures(): undefined {
    return undefined;
  }
}

/** The host's street tiles as imagery (Web Mercator; transparent where no pack has data). */
export class TileSourceImageryProvider {
  readonly tilingScheme = new WebMercatorTilingScheme();
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly minimumLevel = 0;
  readonly maximumLevel: number;
  readonly rectangle = this.tilingScheme.rectangle;
  readonly errorEvent = new Event();
  readonly credit: Credit;
  readonly proxy = undefined;
  readonly hasAlphaChannel = true;
  readonly tileDiscardPolicy = undefined;
  tilesLoaded = 0;
  /** The level of the deepest street tile in view: the style every tile in view is drawn in. */
  viewZoom: number | null = null;
  /** Set by CesiumJS while the layer is shown: draws every loaded tile again, in place. */
  _reload: (() => void) | undefined = undefined;
  /** The style zoom each tile handed over since the last redraw was drawn at. */
  private readonly drawn = new Map<string, number>();

  constructor(
    readonly source: GlobeTileSource,
    pixelRatio: number,
  ) {
    this.tileWidth = Math.round(source.tileSize * pixelRatio);
    this.tileHeight = this.tileWidth;
    this.maximumLevel = source.maxZoom;
    this.credit = new Credit(source.credit);
    // "nothing here at this level" is an answer, not a fault: CesiumJS then keeps the coarser
    // tile; a listener keeps it from writing each one to the console
    this.errorEvent.addEventListener(() => undefined);
  }

  getTileCredits(): Credit[] | undefined {
    return undefined;
  }

  private styleZoom(level: number): number {
    return styleZoomFor(level, this.viewZoom, this.source.styleSteps ?? 0);
  }

  requestImage(x: number, y: number, level: number): Promise<TexImageSource> | undefined {
    const styleZoom = this.styleZoom(level);
    const pending = this.source.request(level, x, y, styleZoom);
    if (!pending) return undefined;
    return pending.then((image) => {
      if (!image) throw new Error('No street tile at this level');
      this.tilesLoaded++;
      if (this.drawn.size > 4000) this.drawn.clear();
      this.drawn.set(`${String(level)}/${String(x)}/${String(y)}`, styleZoom);
      return image;
    });
  }

  /**
   * The street tiles now in view (CesiumJS's own list). When one of them was drawn in another
   * style zoom than the deepest of them asks for, all are drawn again: a coarser tile then shows
   * the same labels, at the same size on the ground, as the finer tile beside it. True when a
   * redraw was started.
   */
  syncView(inView: readonly { level: number; x: number; y: number }[]): boolean {
    if (inView.length === 0) return false;
    this.viewZoom = inView.reduce((deepest, t) => Math.max(deepest, t.level), 0);
    const stale = inView.some((t) => {
      const was = this.drawn.get(`${String(t.level)}/${String(t.x)}/${String(t.y)}`);
      return was !== undefined && was !== this.styleZoom(t.level);
    });
    if (!stale || !this._reload) return false;
    this.drawn.clear();
    this._reload();
    return true;
  }

  pickFeatures(): undefined {
    return undefined;
  }
}

/** A provider as the type CesiumJS's `ImageryLayer` takes (an interface it duck-types). */
export const asProvider = (p: EarthImageryProvider | TileSourceImageryProvider) =>
  p as unknown as ImageryProvider;
