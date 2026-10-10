import type { Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  composeCrop,
  covers,
  cropKey,
  cropWindow,
  drawTransform,
  overlaps,
  parseTiles,
  placementUv,
  tilesFor,
  type CropIo,
  type RasterLayer,
} from './orthoCrop';

// a project origin and an ortho of 200 m x 100 m whose top-left is 100 m west and 50 m north of it
const origin: Vec3 = [500_000, 2_800_000, 100];
const corners = {
  tl: [-100, 0, -50] as Vec3,
  tr: [100, 0, -50] as Vec3,
  bl: [-100, 0, 50] as Vec3,
};

const apply = (t: number[], u: number, v: number) => [
  (t[0] ?? 0) * u + (t[2] ?? 0) * v + (t[4] ?? 0),
  (t[1] ?? 0) * u + (t[3] ?? 0) * v + (t[5] ?? 0),
];

describe('crop geometry', () => {
  it('places a crop around a point in the project CRS', () => {
    const w = cropWindow([500_010, 2_800_020], 60, 1024);
    expect(w).toEqual({ x0: 499_980, y1: 2_800_050, res: 60 / 1024, size: 1024 });
    expect(cropKey('ortho', w)).toBe('ortho@499980000,2800050000,60000,1024');
  });

  it('maps an image pixel to the crop pixel showing the same ground', () => {
    const w = cropWindow([500_000, 2_800_000], 60, 600); // 0.1 m pixels
    const t = drawTransform(corners, 2000, 1000, w, origin); // the ortho at 0.1 m too
    // the image centre (1000, 500) is the origin, the crop centre (300, 300)
    const [x, y] = apply(t, 1000, 500);
    expect(x).toBeCloseTo(300, 9);
    expect(y).toBeCloseTo(300, 9);
    // 10 image pixels east are 10 crop pixels east; 10 south are 10 down
    const [x2, y2] = apply(t, 1010, 510);
    expect(x2).toBeCloseTo(310, 9);
    expect(y2).toBeCloseTo(310, 9);
  });

  it('tells where a point falls on a placement and whether it is covered', () => {
    expect(placementUv(corners, 0, 0)).toEqual([0.5, 0.5]);
    expect(covers(corners, [500_000, 2_800_000], origin)).toBe(true);
    expect(covers(corners, [500_150, 2_800_000], origin)).toBe(false);
    expect(overlaps(corners, cropWindow([500_120, 2_800_000], 60), origin)).toBe(true);
    expect(overlaps(corners, cropWindow([500_200, 2_800_000], 60), origin)).toBe(false);
  });
});

describe('pyramid tiles', () => {
  const index = parseTiles({
    schema: 'aio.tiles/1',
    corners,
    levels: [
      { z: 0, tileSize: 256, cols: 1, rows: 1, pattern: 'rasters/o/{z}/{x}_{y}.webp' }, // 0.78 m
      { z: 1, tileSize: 256, cols: 4, rows: 2, pattern: 'rasters/o/{z}/{x}_{y}.webp' }, // 0.195 m
      { z: 2, tileSize: 256, cols: 16, rows: 8, pattern: 'rasters/o/{z}/{x}_{y}.webp' }, // 0.049 m
    ],
  });

  it('reads a tile index and refuses anything else', () => {
    expect(index?.levels.map((l) => l.z)).toEqual([0, 1, 2]);
    expect(parseTiles({ schema: 'aio.tiles/1', corners, levels: [] })).toBeNull();
    expect(parseTiles({ schema: 'x' })).toBeNull();
  });

  it('takes the coarsest level as sharp as the crop, and only the tiles it overlaps', () => {
    if (!index) throw new Error('no index');
    // 60 m over 1024 px: 0.059 m pixels, so level 2 (0.049 m)
    const fine = tilesFor(index, cropWindow([500_000, 2_800_000], 60), origin);
    expect(new Set(fine.map((t) => t.level.z))).toEqual(new Set([2]));
    // 12.5 m tiles: 60 m around the centre spans tiles 5..10 east and 1..6 south
    expect(Math.min(...fine.map((t) => t.x))).toBe(5);
    expect(Math.max(...fine.map((t) => t.x))).toBe(10);
    expect(fine[0]?.path).toBe('rasters/o/2/5_1.webp');
    // 480 m: 0.47 m pixels, so level 1 (0.195 m), all eight tiles
    const coarse = tilesFor(index, cropWindow([500_000, 2_800_000], 480), origin);
    expect(coarse).toHaveLength(8);
    expect(coarse.every((t) => t.level.z === 1)).toBe(true);
    // too many tiles: a coarser level
    expect(
      tilesFor(index, cropWindow([500_000, 2_800_000], 60), origin, 4).every((t) => t.level.z < 2),
    ).toBe(true);
    expect(tilesFor(index, cropWindow([501_000, 2_800_000], 60), origin)).toEqual([]);
  });
});

describe('composing a crop', () => {
  const layer = (over: Partial<RasterLayer>): RasterLayer =>
    ({
      id: 'ortho',
      name: 'Ortho',
      kind: 'raster',
      role: 'ortho',
      format: 'image',
      src: { path: 'rasters/ortho.png' },
      corners,
      ...over,
    }) as RasterLayer;

  function fakeIo(
    images: Record<string, { width: number; height: number } | null>,
    tiles?: unknown,
  ) {
    const drawn: { url: string; t: number[] }[] = [];
    let current: number[] = [];
    const size = 8;
    const io: CropIo = {
      url: (ref) => ('path' in ref ? ref.path : ref.hash),
      fetchJson: () => Promise.resolve(tiles),
      image: (url) => {
        const img = images[url];
        return Promise.resolve(
          img ? { ...img, source: { url } as unknown as CanvasImageSource } : null,
        );
      },
      canvas: () => ({
        ctx: {
          fillStyle: '',
          imageSmoothingQuality: 'low',
          fillRect: () => undefined,
          setTransform: ((...t: number[]) => {
            current = t;
          }) as never,
          drawImage: ((src: { url: string }) => {
            drawn.push({ url: src.url, t: current });
          }) as never,
          getImageData: (() => {
            const data = new Uint8ClampedArray(size * size * 4);
            for (let i = 0; i < data.length; i += 4) data.set([10, 20, 30, 255], i);
            return { data };
          }) as never,
        },
      }),
    };
    return { io, drawn };
  }

  it('draws an image ortho into the crop and returns its RGB', async () => {
    const { io, drawn } = fakeIo({ 'rasters/ortho.png': { width: 2000, height: 1000 } });
    const r = await composeCrop(layer({}), cropWindow([500_000, 2_800_000], 0.8, 8), origin, io);
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.rgb.slice(0, 6)]).toEqual([10, 20, 30, 10, 20, 30]);
    expect(drawn).toHaveLength(1);
  });

  it('draws the overlapping tiles of a pyramid', async () => {
    const tiles = {
      schema: 'aio.tiles/1',
      corners,
      levels: [{ z: 0, tileSize: 256, cols: 2, rows: 1, pattern: 't/{z}/{x}_{y}.webp' }],
    };
    const { io, drawn } = fakeIo(
      { 't/0/0_0.webp': { width: 256, height: 256 }, 't/0/1_0.webp': { width: 256, height: 256 } },
      tiles,
    );
    const r = await composeCrop(
      layer({ format: 'kit-pyramid', src: { path: 't/tiles.json' } }),
      cropWindow([500_000, 2_800_000], 8, 8),
      origin,
      io,
    );
    expect(r.ok).toBe(true);
    expect(drawn.map((d) => d.url).sort()).toEqual(['t/0/0_0.webp', 't/0/1_0.webp']);
  });

  it('says why when the ortho cannot be read', async () => {
    const { io } = fakeIo({});
    expect(
      await composeCrop(
        layer({ format: 'cog' }),
        cropWindow([500_000, 2_800_000], 8, 8),
        origin,
        io,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/tiled and image orthos/) as unknown,
    });
    expect(
      await composeCrop(layer({}), cropWindow([500_000, 2_800_000], 8, 8), origin, io),
    ).toMatchObject({ ok: false });
  });
});
