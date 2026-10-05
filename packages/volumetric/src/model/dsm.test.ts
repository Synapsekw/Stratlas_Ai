import { describe, expect, it } from 'vitest';
import type { DsmGrid } from './kitdata';
import {
  changeColour,
  changeRaster,
  heightStats,
  hillshade,
  isRampId,
  RAMP_IDS,
  rampColour,
  rampCss,
  reliefColour,
  reliefRaster,
  sampleDsm,
  sectionProfile,
} from './dsm';

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

  it('ramps the terrain relief from green (low) to white (high)', () => {
    const low = reliefColour(0, 0, 10);
    expect(low[1]).toBeGreaterThan(low[0]);
    expect(low[1]).toBeGreaterThan(low[2]);
    expect(reliefColour(10, 0, 10)).toEqual([255, 255, 255]);
  });
});

describe('elevation ramps', () => {
  it('offers vivid, perceptual, terrain and grey ramps', () => {
    expect(RAMP_IDS).toEqual(['turbo', 'spectral', 'viridis', 'terrain', 'inferno', 'grey']);
    expect(isRampId('viridis')).toBe(true);
    expect(isRampId('toString')).toBe(false);
  });

  it('clamps to the ends of the range and interpolates between stops', () => {
    expect(rampColour(-5, 0, 10, 'grey')).toEqual([32, 32, 32]);
    expect(rampColour(50, 0, 10, 'grey')).toEqual([255, 255, 255]);
    const mid = rampColour(5, 0, 10, 'grey');
    expect(mid[0]).toBe(Math.round(32 + (255 - 32) / 2));
    // turbo: dark blue at the bottom, dark red at the top
    const lo = rampColour(0, 0, 1, 'turbo');
    const hi = rampColour(1, 0, 1, 'turbo');
    expect(lo[2]).toBeGreaterThan(lo[0]);
    expect(hi[0]).toBeGreaterThan(hi[2]);
    expect(rampCss('viridis').startsWith('linear-gradient(90deg, #440154')).toBe(true);
  });

  it('keeps cells without data transparent so the photo shows through', () => {
    const d = grid('e1', 0, [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    for (const hs of [false, true]) {
      const r = reliefRaster(d, 50, 53, { ramp: 'viridis', hillshade: hs });
      expect(r.data[3]).toBe(0);
      expect(r.data[4 * 11 + 3]).toBe(0);
      expect(r.data[7]).toBe(255);
    }
  });

  it('lights slopes facing the north-west sun and darkens the others', () => {
    // heights rise to the east: the slope faces west, lit by the west and north-west lights
    const west = hillshade(grid('e1'));
    // the mirror: rising to the west, the slope faces east, away from the light
    const mirrored = grid('e1');
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) mirrored.z[y * 4 + x] = (3 - x) * 100;
    const east = hillshade(mirrored);
    expect(west[5] ?? 0).toBeGreaterThan(east[5] ?? 0);
    // flat ground keeps its colour (shade about 0.71)
    const flat = grid('e1');
    flat.z.fill(0);
    expect(hillshade(flat)[5]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(Number.isNaN(hillshade(grid('e1', 0, [0, ...new Array<number>(11).fill(1)]))[0])).toBe(
      true,
    );
  });

  it('measures the automatic range and extent of the surveys', () => {
    const { auto, extent } = heightStats([grid('e1')], 1);
    expect(extent).toEqual([50, 53]);
    expect(auto[0]).toBeGreaterThanOrEqual(50);
    expect(auto[1]).toBeLessThanOrEqual(53);
  });
});
