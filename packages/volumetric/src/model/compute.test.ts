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
  it('recomputes every base and date of a pile from its 10 cm grid', async () => {
    const { c } = compute();
    const r = await c.recompute('P01');
    expect(r.e1).toBeNull();
    expect(r.e2?.tin.net).toBeCloseTo(0.8, 6);
    expect(r.e2?.avg.net).toBeCloseTo(0.44, 6);
  });

  it('loads each grid once', async () => {
    const { c, loads } = compute();
    await c.recompute('P01');
    await c.recompute('P01');
    expect(loads.filter((u) => u === 'piles/P01.js')).toHaveLength(1);
  });

  it('builds coarse bodies for the site and a fine body for the selected pile', async () => {
    const { c } = compute();
    const site = await c.scene({
      epoch: 'e2',
      base: 'tin',
      mode: 'inv',
      selected: null,
      piles: [{ id: 'P01', ring, edited: false }],
    });
    expect(site.piles[0]?.body?.cell).toBeCloseTo(0.4, 9);
    expect(site.piles[0]?.toe.length).toBeGreaterThan(0);
    const sel = await c.scene({
      epoch: 'e2',
      base: 'tin',
      mode: 'inv',
      selected: 'P01',
      piles: [{ id: 'P01', ring, edited: false }],
    });
    expect(sel.piles[0]?.body?.cell).toBeCloseTo(0.3, 9);
  });

  it('builds signed change bodies between the first and last survey', async () => {
    const { c } = compute();
    const s = await c.scene({
      epoch: 'e2',
      base: 'tin',
      mode: 'chg',
      selected: 'P01',
      piles: [{ id: 'P01', ring, edited: false }],
    });
    const b = s.piles[0]?.body;
    expect(b?.d).toBeDefined();
    expect(Math.max(...(b?.d ?? []))).toBeCloseTo(2, 5);
  });

  it('recomputes an edited toe line with every base refitted, and drapes it', async () => {
    const { c } = compute();
    const e = await c.edit({ pile: 'P01', epoch: 'e2', ring, base: 'low' });
    if (!e) throw new Error('no edit');
    // the line sits on the floor (51 m) around the 2 m block of 0.4 m²
    expect(e.result.volumes.low.fill).toBeCloseTo(0.8, 1);
    expect(e.body.ins.some((v) => v === 1)).toBe(true);
    expect(e.vertices).toHaveLength(4);
    expect(e.vertices[0]?.[2]).toBeCloseTo(51, 6);
  });

  it('profiles a section across both surveys', async () => {
    const { c } = compute();
    const p = await c.section([1000, 2000], [1003, 2000]);
    expect(p.fillM2).toBeGreaterThan(0);
    expect(p.cutM2).toBe(0);
  });

  it('paints the change and relief rasters on the DSM grid', async () => {
    const { c } = compute();
    const r = await c.changeRaster();
    expect([r.width, r.height]).toEqual([10, 5]);
    const g = await c.grid();
    expect(g).toMatchObject({ w: 10, h: 5, res: 0.4, x0: 999.6, y1: 2000.4 });
    expect(g.relief[0]).toBeCloseTo(51, 6);
    expect(g.relief[1]).toBeCloseTo(51.5, 6);
    const rel = await c.reliefRaster('e1');
    expect(rel.data[3]).toBe(255);
  });

  it('says which grid is missing', async () => {
    const { c } = compute();
    await expect(c.recompute('P09')).rejects.toThrow(/P09/);
  });

  it('offers the general engine bases beside the kit ones, on the pile grid', async () => {
    const { c } = compute();
    const kit = await c.recompute('P01');
    const r = await c.engineBases('P01', 'e2', ring);
    expect(r.map((b) => b.key)).toEqual([
      'smart',
      'fit-plane',
      'perimeter-mean',
      'perimeter-min',
      'perimeter-max',
    ]);
    // the block (1 m by 0.4 m, 2 m high) on a flat floor: every toe base is the floor
    for (const b of r) {
      expect(b.result.status, b.key).toBe('ok');
      expect(b.result.netM3, b.key).toBeCloseTo(0.8, 6);
      expect(b.result.engine).toBe('ts');
    }
    // the kit's own numbers are what they were
    expect(kit.e2?.tin.net).toBeCloseTo(0.8, 6);
    expect(await c.engineBases('P01', 'e9', ring)).toEqual([]);
  });
});
