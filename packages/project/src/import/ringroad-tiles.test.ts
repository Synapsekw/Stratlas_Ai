import { describe, expect, it } from 'vitest';
import { fromWgs84, toWgs84 } from '@aio/geo';
import {
  bestShift,
  levelCorners,
  parseRrtBundle,
  planPyramid,
  resampleBilinear,
  tileToSource,
  windowTiles,
  worldPx,
  worldPxToLonLat,
  zOrder,
} from './ringroad-tiles';

const UTM38 = 32638;
const toLonLat = (e: number, n: number): [number, number] => {
  const [lon, lat] = toWgs84([e, n, 0], UTM38);
  return [lon, lat];
};

describe('road review ortho bundles', () => {
  it('reads the tiles of an RRT script bundle by z/x/y', () => {
    const a = Buffer.from('RIFFabc').toString('base64');
    const b = Buffer.from('RIFFdefgh').toString('base64');
    const text = `RRT("18/1/2",{"18/1/2":"${a}","19/2/4":"${b}"});\n`;
    const tiles = parseRrtBundle(text);
    expect([...tiles.keys()]).toEqual(['18/1/2', '19/2/4']);
    expect(Buffer.from(tiles.get('19/2/4') ?? []).toString()).toBe('RIFFdefgh');
  });

  it('rejects a file that is not a bundle', () => {
    expect(() => parseRrtBundle('window.X={}')).toThrow(/bundle/);
  });
});

describe('web mercator pixels', () => {
  it('puts lon 0, lat 0 at the centre of the world', () => {
    expect(worldPx(0, 0, 0)).toEqual([128, 128]);
    expect(worldPx(0, 0, 1)).toEqual([256, 256]);
  });

  it('round trips a Kuwait City position at z22', () => {
    const [x, y] = worldPx(47.9941911, 29.3854794, 22);
    // tile of the first defect of the survey is in the z18 bundle 165995..166023
    expect(Math.floor(x / 256 / 16)).toBeGreaterThanOrEqual(165995);
    const [lon, lat] = worldPxToLonLat(x, y, 22);
    expect(lon).toBeCloseTo(47.9941911, 9);
    expect(lat).toBeCloseTo(29.3854794, 9);
  });
});

describe('local frame pyramid plan', () => {
  const bounds = { minE: 787300, minN: 3251200, maxE: 791100, maxN: 3254500 };
  const plan = planPyramid(bounds, {
    finestM: 0.0325,
    tileSize: 512,
    levels: 9,
    finestSrcZoom: 22,
  });

  it('covers the bounds with one square that halves cleanly at every level', () => {
    expect(plan.size).toBeCloseTo(256 * 512 * 0.0325, 6);
    expect(plan.left).toBeLessThanOrEqual(bounds.minE);
    expect(plan.left + plan.size).toBeGreaterThanOrEqual(bounds.maxE);
    expect(plan.top).toBeGreaterThanOrEqual(bounds.maxN);
    expect(plan.top - plan.size).toBeLessThanOrEqual(bounds.minN);
    expect(plan.levels.map((l) => l.cols)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256]);
    expect(plan.levels.map((l) => l.srcZoom)).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22]);
    expect(plan.levels[0]?.metresPerPx).toBeCloseTo(8.32, 2);
    expect(plan.levels[8]?.pattern).toBe('rasters/ortho/8/{x}_{y}.webp');
  });

  it('places the corners in the local frame (x east, z south) around the origin', () => {
    const origin: [number, number, number] = [789200, 3252850, 0];
    const c = levelCorners(plan, origin);
    expect(c.tl).toEqual([plan.left - 789200, 0, -(plan.top - 3252850)]);
    expect(c.tr[0] - c.tl[0]).toBeCloseTo(plan.size, 9);
    expect(c.bl[2] - c.tl[2]).toBeCloseTo(plan.size, 9);
  });

  it('still covers bounds that leave less than a metre to snap the corner', () => {
    const b = { minE: 790613.2, minN: 3254421.3, maxE: 790616.2, maxN: 3254424.3 };
    const p = planPyramid(b, { finestM: 0.0325, tileSize: 64, levels: 2, finestSrcZoom: 22 });
    expect(p.left).toBeLessThanOrEqual(b.minE);
    expect(p.left + p.size).toBeGreaterThanOrEqual(b.maxE);
    expect(p.top).toBeGreaterThanOrEqual(b.maxN);
    expect(p.top - p.size).toBeLessThanOrEqual(b.minN);
  });

  it('refuses bounds larger than the pyramid', () => {
    expect(() =>
      planPyramid(
        { minE: 0, minN: 0, maxE: 9000, maxN: 10 },
        { finestM: 0.0325, tileSize: 512, levels: 9, finestSrcZoom: 22 },
      ),
    ).toThrow(/does not fit/);
  });
});

describe('output tile to source pixels', () => {
  const plan = planPyramid(
    { minE: 787300, minN: 3251200, maxE: 791100, maxN: 3254500 },
    { finestM: 0.0325, tileSize: 512, levels: 9, finestSrcZoom: 22 },
  );
  const level = plan.levels[8];
  if (!level) throw new Error('no finest level');

  it('maps every output pixel onto the mercator source within a hundredth of a pixel', () => {
    const tx = 140;
    const ty = 77;
    const m = tileToSource(plan, level, tx, ty, toLonLat);
    expect(m.err).toBeLessThan(0.01);
    // an output pixel centre, projected exactly
    const u = 300.5;
    const v = 41.5;
    const e = plan.left + (tx * 512 + u) * level.metresPerPx;
    const n = plan.top - (ty * 512 + v) * level.metresPerPx;
    const [lon, lat] = toLonLat(e, n);
    const [x, y] = worldPx(lon, lat, 22);
    expect(m.a * u + m.b * v + m.c).toBeCloseTo(x, 2);
    expect(m.d * u + m.e * v + m.f).toBeCloseTo(y, 2);
  });

  it('lists the source tiles an output tile needs', () => {
    const m = { a: 1, b: 0, c: 1000, d: 0, e: 1, f: 2000, err: 0 };
    expect(windowTiles(m, 512)).toEqual({ x0: 3, y0: 7, x1: 6, y1: 10 });
  });
});

describe('bilinear resampling', () => {
  // 4 x 2 source: left half red, right half blue, all opaque, except one transparent pixel
  const src = new Uint8Array(4 * 2 * 4);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++) {
      const o = (y * 4 + x) * 4;
      src.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], o);
    }

  it('copies pixels through an identity map', () => {
    const out = resampleBilinear(
      { data: src, width: 4, height: 2 },
      { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, err: 0 },
      2,
      [9, 9, 9],
    );
    expect([...out.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(out.covered).toBe(4);
  });

  it('blends neighbours half way between pixel centres', () => {
    // output pixel 0 centre (0.5) maps to source x = 2.0: half red, half blue
    const out = resampleBilinear(
      { data: src, width: 4, height: 2 },
      { a: 1, b: 0, c: 1.5, d: 0, e: 1, f: 0, err: 0 },
      1,
      [0, 0, 0],
    );
    expect([...out.data.slice(0, 4)]).toEqual([128, 0, 128, 255]);
  });

  it('fills pixels outside the source with the no-data colour and alpha 0', () => {
    const out = resampleBilinear(
      { data: src, width: 4, height: 2 },
      { a: 1, b: 0, c: 100, d: 0, e: 1, f: 0, err: 0 },
      1,
      [20, 29, 45],
    );
    expect([...out.data.slice(0, 4)]).toEqual([20, 29, 45, 0]);
    expect(out.covered).toBe(0);
  });

  it('does not darken the colour next to transparent pixels', () => {
    const edge = src.slice();
    edge.set([0, 0, 0, 0], 1 * 4); // pixel (1, 0) transparent
    const out = resampleBilinear(
      { data: edge, width: 4, height: 2 },
      { a: 1, b: 0, c: 0.5, d: 0, e: 1, f: 0, err: 0 },
      1,
      [0, 0, 0],
    );
    // samples at source (0.5, 0): half way between red pixel 0 and transparent pixel 1
    expect(out.data[0]).toBe(255);
    expect(out.data[3]).toBe(128);
  });
});

describe('image shift check', () => {
  // a textured 40 x 30 grey image and the same image moved 3 px right and 2 px down
  const w = 40;
  const h = 30;
  const tex = (x: number, y: number) => Math.sin(x * 0.7) * 40 + Math.cos(y * 1.3 + x * 0.2) * 50;
  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      a[y * w + x] = tex(x, y);
      b[y * w + x] = tex(x - 3, y - 2);
    }

  it('finds the offset of b against a', () => {
    const s = bestShift(a, b, w, h, 6);
    expect(s).toMatchObject({ dx: 3, dy: 2 });
    expect(s.score).toBeGreaterThan(0.99);
  });

  it('refines the shift to a fraction of a pixel', () => {
    const smooth = (x: number, y: number) =>
      Math.sin(x * 0.31) * 50 + Math.cos(y * 0.27 + x * 0.05) * 40;
    const p = new Float32Array(w * h);
    const q = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        p[y * w + x] = smooth(x, y);
        q[y * w + x] = smooth(x - 1.4, y + 0.6);
      }
    const s = bestShift(p, q, w, h, 4);
    // a parabola through three correlation samples is good to about a tenth of a pixel
    expect(Math.abs(s.sx - 1.4)).toBeLessThan(0.15);
    expect(Math.abs(s.sy + 0.6)).toBeLessThan(0.15);
  });

  it('reports no correlation for a flat image', () => {
    const s = bestShift(new Float32Array(w * h), b, w, h, 4);
    expect(s.score).toBe(0);
  });
});

describe('tile order', () => {
  it('walks tiles in z-order so neighbours stay close', () => {
    const order = zOrder([
      [1, 1],
      [0, 0],
      [2, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(order).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 0],
    ]);
  });
});

it('converts between UTM 38N and lon/lat through the geo registry', () => {
  const [e, n] = fromWgs84([47.9941911, 29.3854794, 0], UTM38);
  expect(e).toBeCloseTo(790614.47, 0);
  expect(n).toBeCloseTo(3254422.84, 0);
});
