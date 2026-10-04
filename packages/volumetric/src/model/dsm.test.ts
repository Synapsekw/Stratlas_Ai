import { describe, expect, it } from 'vitest';
import type { DsmGrid } from './kitdata';
import { changeColour, changeRaster, reliefColour, sampleDsm, sectionProfile } from './dsm';

/** 4 x 3 cells of 1 m from (0, 3): heights rise 1 m per column east, cm above zoff 50. */
function grid(epoch: string, add = 0, valid?: number[]): DsmGrid {
  const w = 4;
  const h = 3;
  const z = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) z[y * w + x] = x * 100 + add;
  return {
    epoch,
    w,
    h,
    res: 1,
    x0: 0,
    y1: 3,
    zoff: 50,
    z,
    valid: Uint8Array.from(valid ?? new Array<number>(w * h).fill(1)),
  };
}

describe('sampleDsm', () => {
  it('interpolates between cell centres', () => {
    const d = grid('e1');
    expect(sampleDsm(d, 0.5, 2.5)).toBeCloseTo(50, 9);
    expect(sampleDsm(d, 1.0, 2.5)).toBeCloseTo(50.5, 9);
    expect(sampleDsm(d, 2.75, 1.5)).toBeCloseTo(52.25, 9);
  });

  it('is null outside the grid and next to invalid cells', () => {
    const d = grid('e1', 0, [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1]);
    expect(sampleDsm(d, -1, 1)).toBeNull();
    expect(sampleDsm(d, 3.9, 1.5)).toBeNull();
    expect(sampleDsm(d, 1.2, 2.2)).toBeNull();
    expect(sampleDsm(d, 2.6, 1.0)).not.toBeNull();
  });
});

describe('sectionProfile', () => {
  it('samples both surveys along the line and sums cut and fill areas', () => {
    const a = grid('e1');
    const b = grid('e2', 50); // 0.5 m higher everywhere
    const p = sectionProfile(a, b, [0.5, 1.5], [3.4, 1.5], 0.1);
    expect(p.lengthM).toBeCloseTo(2.9, 9);
    expect(p.s[0]).toBe(0);
    expect(p.s.at(-1)).toBeCloseTo(2.9, 9);
    expect(p.z1[0]).toBeCloseTo(50, 9);
    expect(p.z2.at(-1)).toBeCloseTo(53.4, 9);
    // 0.5 m of fill along 2.9 m; like the kit, all 9 samples count one 2.9 / 8 m step each
    expect(p.fillM2).toBeCloseTo((0.5 * 2.9 * 9) / 8, 9);
    expect(p.cutM2).toBe(0);
  });

  it('ignores changes inside the deadband', () => {
    const p = sectionProfile(grid('e1'), grid('e2', 5), [0.5, 1.5], [3.5, 1.5], 0.1);
    expect(p.fillM2).toBe(0);
  });
});

describe('change colours', () => {
  it('greys changes inside the deadband and ramps cut to red, fill to blue', () => {
    expect(changeColour(0.05, 0.1)).toEqual([138, 138, 138]);
    const cut = changeColour(-3, 0.1);
    const fill = changeColour(3, 0.1);
    expect(cut[0]).toBeGreaterThan(cut[2]);
    expect(fill[2]).toBeGreaterThan(fill[0]);
  });

  it('paints a north-up RGBA raster, transparent where either survey has no data', () => {
    const a = grid('e1', 0, [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const b = grid('e2', 200);
    const r = changeRaster(a, b, 0.1);
    expect([r.width, r.height]).toEqual([4, 3]);
    expect(r.data[3]).toBe(0);
    expect(r.data[7]).toBe(255);
    // +2 m everywhere: blue dominant
    expect(r.data[6] ?? 0).toBeGreaterThan(r.data[4] ?? 0);
  });

  it('ramps elevation from blue (low) to white (high)', () => {
    expect(reliefColour(0, 0, 10)).toEqual([31, 111, 191]);
    expect(reliefColour(10, 0, 10)).toEqual([255, 255, 255]);
  });
});
