// @vitest-environment jsdom
import { Cartographic, Math as CMath } from '@cesium/core';
import { GeographicTilingScheme } from '@cesium/engine';
import type { Vec3 } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SiteGeoref } from '../geodesy';
import { parsePyramid, pyramidPlacement, type PyramidIndex } from '../projectRasters';
import { KitPyramidImageryProvider } from './projectRasterProvider';

/** One level of 2 by 1 tiles of 256 px over 600 by 300 m: the left tile red, the right blue. */
const pyramidOf = (level: { cols: number; rows: number; tileSize: number }): PyramidIndex => {
  const index = parsePyramid({
    schema: 'aio.tiles/1',
    levels: [{ z: 0, pattern: 'rasters/heat/{z}/{x}_{y}.png', ...level }],
    corners: {
      tl: [-300, 0, -150] as Vec3,
      tr: [300, 0, -150] as Vec3,
      bl: [-300, 0, 150] as Vec3,
    },
  });
  if (!index) throw new Error('the test pyramid did not parse');
  return index;
};
const FRAME: Pick<SiteGeoref, 'crs' | 'origin'> = {
  crs: { epsg: 32640 },
  origin: [412_000, 3_245_000, 20],
};
const PATH = { left: 'rasters/heat/0/0_0.png', right: 'rasters/heat/0/1_0.png' };

interface FakeBitmap {
  colour: 'red' | 'blue';
  width: number;
  height: number;
  close: Mock<() => void>;
}
const bitmapOf = (path: string): FakeBitmap => ({
  colour: path === PATH.left ? 'red' : 'blue',
  width: 256,
  height: 256,
  close: vi.fn(),
});

/** What a canvas was asked to draw. */
interface FakeContext {
  canvas: HTMLCanvasElement;
  draws: { transform: number[]; image: unknown; args: number[] }[];
  setTransform: (...m: number[]) => void;
  drawImage: (image: unknown, ...args: number[]) => void;
  clearRect: () => void;
}
let contexts: FakeContext[] = [];

beforeEach(() => {
  contexts = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let transform = [1, 0, 0, 1, 0, 0];
    const ctx: FakeContext = {
      canvas: this,
      draws: [],
      setTransform: (...m) => {
        transform = m;
      },
      drawImage: (image, ...args) => {
        ctx.draws.push({ transform, image, args });
      },
      clearRect: () => undefined,
    };
    contexts.push(ctx);
    return ctx as unknown as CanvasRenderingContext2D;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const setup = (cacheTiles = 8, fetchTile?: (path: string) => Promise<ImageBitmap>) => {
  const index = pyramidOf({ cols: 2, rows: 1, tileSize: 256 });
  const placement = pyramidPlacement(index, FRAME);
  const bitmaps: FakeBitmap[] = [];
  const fetch = vi.fn(
    fetchTile ??
      ((path: string) => {
        const b = bitmapOf(path);
        bitmaps.push(b);
        return Promise.resolve(b as unknown as ImageBitmap);
      }),
  );
  const provider = new KitPyramidImageryProvider(index, placement, fetch, { cacheTiles });
  return { index, placement, provider, fetch, bitmaps };
};

/** The level 18 geographic tile (about 76 m) at a point of the pyramid. */
const tileAt = (placement: ReturnType<typeof pyramidPlacement>, u: number, v: number) => {
  const [lon, lat] = placement.toLonLat(u, v);
  const xy = new GeographicTilingScheme().positionToTileXY(Cartographic.fromDegrees(lon, lat), 18);
  return { x: xy.x, y: xy.y, level: 18 };
};

describe('KitPyramidImageryProvider', () => {
  it('covers the placement rectangle on a geographic tiling scheme', () => {
    const { provider, placement } = setup();
    expect(provider.tilingScheme).toBeInstanceOf(GeographicTilingScheme);
    const [w, s, e, n] = placement.rect;
    expect(provider.rectangle.west).toBeCloseTo(CMath.toRadians(w), 12);
    expect(provider.rectangle.south).toBeCloseTo(CMath.toRadians(s), 12);
    expect(provider.rectangle.east).toBeCloseTo(CMath.toRadians(e), 12);
    expect(provider.rectangle.north).toBeCloseTo(CMath.toRadians(n), 12);
    expect(provider.tileWidth).toBe(256);
    expect(provider.hasAlphaChannel).toBe(true);
  });

  it('draws the left pyramid tile alone into a tile over the left half, corners within 0.5 px', async () => {
    const { provider, placement, fetch, bitmaps } = setup();
    const { x, y, level } = tileAt(placement, 0.25, 0.5);
    const canvas = await provider.requestImage(x, y, level);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(PATH.left);
    const ctx = contexts.find((c) => c.canvas === canvas);
    expect(ctx?.draws).toHaveLength(1);
    const draw = ctx?.draws[0];
    expect(draw?.image).toBe(bitmaps[0]);
    expect(draw?.args).toEqual([0, 0, 1, 1]);
    // the transform takes the unit square of the bitmap to the tile's place on the canvas
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = draw?.transform ?? [];
    const r = new GeographicTilingScheme().tileXYToRectangle(x, y, level);
    const [west, south, east, north] = [r.west, r.south, r.east, r.north].map(CMath.toDegrees) as [
      number,
      number,
      number,
      number,
    ];
    const px = (u: number, v: number): [number, number] => {
      const [lon, lat] = placement.toLonLat(u, v);
      return [((lon - west) / (east - west)) * 256, ((north - lat) / (north - south)) * 256];
    };
    const corners: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [1, 0, 0.5, 0],
      [0, 1, 0, 1],
      [1, 1, 0.5, 1],
    ];
    for (const [s, t, u, v] of corners) {
      const [ex, ey] = px(u, v);
      expect(Math.abs(a * s + c * t + e - ex)).toBeLessThan(0.5);
      expect(Math.abs(b * s + d * t + f - ey)).toBeLessThan(0.5);
    }
    expect(provider.stats()).toEqual({ tiles: 1, lastError: null });
  });

  it('turns a failing read into a transparent tile and lastError, never a rejection', async () => {
    const { provider, placement } = setup(8, () => Promise.reject(new Error('no such file')));
    const { x, y, level } = tileAt(placement, 0.25, 0.5);
    const canvas = await provider.requestImage(x, y, level);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(contexts.find((c) => c.canvas === canvas)?.draws ?? []).toHaveLength(0);
    expect(provider.stats().lastError).toContain('no such file');
    expect(provider.stats().tiles).toBe(0);
  });

  it('gives the shared transparent tile, without a read, outside the pyramid', async () => {
    const { provider, placement, fetch } = setup();
    const far = tileAt(placement, 30, 30);
    const one = await provider.requestImage(far.x, far.y, far.level);
    const two = await provider.requestImage(far.x + 1, far.y, far.level);
    expect(fetch).not.toHaveBeenCalled();
    expect(one).toBe(two);
    expect(one.width).toBe(1);
    expect(one.height).toBe(1);
  });

  it('keeps at most cacheTiles decoded tiles, closing what it drops, and closes all on dispose', async () => {
    const { provider, placement, fetch, bitmaps } = setup(1);
    const left = tileAt(placement, 0.25, 0.5);
    const right = tileAt(placement, 0.75, 0.5);
    await provider.requestImage(left.x, left.y, left.level);
    await provider.requestImage(left.x, left.y, left.level);
    expect(fetch).toHaveBeenCalledTimes(1);
    await provider.requestImage(right.x, right.y, right.level);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bitmaps[0]?.close).toHaveBeenCalledTimes(1);
    expect(bitmaps[1]?.close).not.toHaveBeenCalled();
    provider.dispose();
    expect(bitmaps[1]?.close).toHaveBeenCalledTimes(1);
  });

  it('stops at the geographic level whose 256 px ground pixel is the finest of the pyramid, at most 22', () => {
    const { provider, placement } = setup();
    const finest = placement.metresPerPx.at(-1) ?? 0;
    const mpp = (level: number) => ((180 / 2 ** level) * 111_320) / 256;
    expect(mpp(provider.maximumLevel)).toBeLessThanOrEqual(finest);
    expect(mpp(provider.maximumLevel - 1)).toBeGreaterThan(finest);
    expect(provider.maximumLevel).toBe(17);

    const fine = pyramidOf({ cols: 128, rows: 64, tileSize: 512 });
    const capped = new KitPyramidImageryProvider(
      fine,
      pyramidPlacement(fine, FRAME),
      () => Promise.reject(new Error('unused')),
      { cacheTiles: 4 },
    );
    expect(capped.maximumLevel).toBe(22);
  });
});
