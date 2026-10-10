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
import type { GlobeTileSource } from '../layers';

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

  requestImage(x: number, y: number, level: number): Promise<TexImageSource> | undefined {
    const pending = this.source.request(level, x, y);
    if (!pending) return undefined;
    return pending.then((image) => {
      if (!image) throw new Error('No street tile at this level');
      this.tilesLoaded++;
      return image;
    });
  }

  pickFeatures(): undefined {
    return undefined;
  }
}

/** A provider as the type CesiumJS's `ImageryLayer` takes (an interface it duck-types). */
export const asProvider = (p: EarthImageryProvider | TileSourceImageryProvider) =>
  p as unknown as ImageryProvider;
