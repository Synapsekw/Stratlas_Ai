import { describe, expect, it } from 'vitest';
import { encodeBits, encodeDeltaI16, syntheticPile } from '../testing';
import { VolumeCompute, type GridSources } from './compute';

/** Site DSM 0.4 m over the synthetic pile (x0 1000, y1 2000, 2 m x 1 m): 10 x 5 cells. */
function site(epoch: string, height: number) {
  const w = 10;
  const h = 5;
  return `window.VS_DSM=window.VS_DSM||{};window.VS_DSM["${epoch}"]=${JSON.stringify({
    res: 0.4,
    w,
    h,
    x0: 999.6,
    y1: 2000.4,
    zoff: 50,
    z: encodeDeltaI16(new Array<number>(w * h).fill(height), w, h),
    valid: encodeBits(new Array<number>(w * h).fill(1)),
  })};`;
}

function coarse() {
  const bits = encodeBits([1, 1, 1, 1]);
  const tin = encodeDeltaI16([100, 100, 100, 100], 2, 2);
  const ep = { m: bits, tin, low: 51, avg: 51, plane: { c: [51, 0, 0], x0: 1000, y1: 2000 } };
  return `window.VS_VOL=${JSON.stringify({
    res: 0.4,
    x0: 999.6,
    y1: 2000.4,
    piles: { P01: { bx0: 3, by0: 1, w: 2, h: 2, zone: bits, e2: ep } },
  })};`;
}

const SOURCES: GridSources = {
  pile: (id) => `piles/${id}.js`,
  dsm: (e) => `dsm_${e}.js`,
  coarse: 'vol.js',
};

function compute() {
  const files: Record<string, string> = {
    'piles/P01.js': syntheticPile().text,
    'dsm_e1.js': site('e1', 100),
    'dsm_e2.js': site('e2', 150),
    'vol.js': coarse(),
  };
  const loads: string[] = [];
  const c = new VolumeCompute({
    fetchText: (url) => {
      loads.push(url);
      const t = files[url];
      return t === undefined ? Promise.reject(new Error(`404 ${url}`)) : Promise.resolve(t);
    },
    sources: SOURCES,
    epochs: ['e1', 'e2'],
    deadband: 0.1,
  });
  return { c, loads };
}

const ring: [number, number][] = [
  [1000.3, 1999.85],
  [1001.7, 1999.85],
  [1001.7, 1999.15],
  [1000.3, 1999.15],
];

describe('VolumeCompute', () => {
  it('loads each grid once', async () => {
    const { c, loads } = compute();
    const req = { epoch: 'e2', piles: [{ id: 'P01', ring }] };
    await c.scene(req);
    await c.scene(req);
    expect(loads.filter((u) => u === 'dsm_e2.js')).toHaveLength(1);
  });

  it('returns toe lines only: the kit bodies and their base are retired', async () => {
    const { c, loads } = compute();
    const s = await c.scene({ epoch: 'e2', piles: [{ id: 'P01', ring }] });
    expect(Object.keys(s.piles[0] ?? {}).sort()).toEqual(['id', 'toe']);
    expect(s.piles[0]?.toe.length).toBeGreaterThan(0);
    // neither the pile's 10 cm grid nor the pile masks are read for it
    expect(loads).toEqual(['dsm_e2.js']);
  });

  it('drapes the toe on the survey the view shows', async () => {
    const { c } = compute();
    const toeZ = async (epoch: string) => {
      const s = await c.scene({ epoch, piles: [{ id: 'P01', ring }] });
      const toe = s.piles[0]?.toe ?? [];
      expect(toe.length).toBeGreaterThan(0);
      return toe.filter((_, i) => i % 3 === 2);
    };
    const first = await toeZ('e1');
    const last = await toeZ('e2');
    // the synthetic site lies 0.5 m higher on the second survey
    expect(first.every((z) => Math.abs(z - (first[0] ?? 0)) < 1e-6)).toBe(true);
    expect((last[0] ?? 0) - (first[0] ?? 0)).toBeCloseTo(0.5, 5);
  });

  it('has no section and no heights operation any more', () => {
    const { c } = compute();
    expect('section' in c).toBe(false);
    expect('heights' in c).toBe(false);
  });

  it('paints the change and relief rasters on the DSM grid', async () => {
    const { c } = compute();
    const r = await c.changeRaster();
    expect([r.width, r.height]).toEqual([10, 5]);
    // the picked surveys the other way round colour the same cells as cut, not fill
    const back = await c.changeRaster('e2', 'e1');
    expect([...back.data.slice(0, 4)]).not.toEqual([...r.data.slice(0, 4)]);
    const g = await c.grid();
    expect(g).toMatchObject({ w: 10, h: 5, res: 0.4, x0: 999.6, y1: 2000.4 });
    expect(g.relief[0]).toBeCloseTo(51, 6);
    expect(g.relief[1]).toBeCloseTo(51.5, 6);
    const rel = await c.reliefRaster('e1');
    expect(rel.data[3]).toBe(255);
  });

  it('says which grid is missing', async () => {
    const { c } = compute();
    await expect(c.changeRaster('e1', 'e9')).rejects.toThrow(/e9/);
  });
});
