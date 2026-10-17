import { describe, expect, it } from 'vitest';
import {
  COST231_RANGE_MHZ,
  HATA_RANGE_MHZ,
  PathLossRefusalError,
  cost231HataDb,
  freeSpacePathLossDb,
  losProbability38901,
  makePathLoss,
  okumuraHataDb,
  pathLossDb,
  pathLossRefusal,
  pathLossWarnings,
  rma38901,
  uma38901,
  umi38901,
} from './propagation';

const log10 = Math.log10;

describe('free space', () => {
  it('matches the textbook 32.45 + 20 log f(MHz) + 20 log d(km)', () => {
    // 1 GHz at 1 km is the classic 92.45 dB.
    expect(freeSpacePathLossDb(1000, 1000)).toBeCloseTo(92.45, 2);
    expect(freeSpacePathLossDb(2600, 3000)).toBeCloseTo(
      32.45 + 20 * log10(2600) + 20 * log10(3),
      2,
    );
  });
  it('rises 6.02 dB per doubling of distance', () => {
    expect(freeSpacePathLossDb(1840, 400) - freeSpacePathLossDb(1840, 200)).toBeCloseTo(6.0206, 3);
  });
});

describe('Okumura-Hata', () => {
  it('gives the textbook 126.4 dB at 900 MHz, 30 m, 1.5 m, 1 km (urban, medium city)', () => {
    expect(okumuraHataDb(900, 1000, 30, 1.5, 'urban')).toBeCloseTo(126.4, 1);
  });
  it('applies the suburban and open-area corrections', () => {
    const u = okumuraHataDb(900, 5000, 30, 1.5, 'urban');
    expect(okumuraHataDb(900, 5000, 30, 1.5, 'suburban')).toBeCloseTo(
      u - 2 * log10(900 / 28) ** 2 - 5.4,
      6,
    );
    expect(okumuraHataDb(900, 5000, 30, 1.5, 'open')).toBeCloseTo(
      u - 4.78 * log10(900) ** 2 + 18.33 * log10(900) - 40.94,
      6,
    );
  });
  it('uses the large-city a(hm) above 300 MHz', () => {
    const medium = okumuraHataDb(900, 2000, 30, 5, 'urban');
    const large = okumuraHataDb(900, 2000, 30, 5, 'urban-large');
    const aMedium = (1.1 * log10(900) - 0.7) * 5 - (1.56 * log10(900) - 0.8);
    const aLarge = 3.2 * log10(11.75 * 5) ** 2 - 4.97;
    expect(large - medium).toBeCloseTo(aMedium - aLarge, 6);
  });
  it('refuses 2600 MHz with the range in the reason', () => {
    expect(() => okumuraHataDb(2600, 1000, 30, 1.5, 'urban')).toThrow(PathLossRefusalError);
    expect(() => okumuraHataDb(2600, 1000, 30, 1.5, 'urban')).toThrow(/150 to 1500 MHz/);
    const r = pathLossRefusal({
      model: 'okumura-hata',
      environment: 'uma',
      frequencyMHz: 2600,
      hBsM: 30,
      hUtM: 1.5,
    });
    expect(r).toMatchObject({ code: 'frequency', rangeMHz: [...HATA_RANGE_MHZ] });
  });
  it('accepts the range edges and refuses just outside', () => {
    expect(() => okumuraHataDb(150, 1000, 30, 1.5, 'urban')).not.toThrow();
    expect(() => okumuraHataDb(1500, 1000, 30, 1.5, 'urban')).not.toThrow();
    expect(() => okumuraHataDb(149.9, 1000, 30, 1.5, 'urban')).toThrow(PathLossRefusalError);
    expect(() => okumuraHataDb(1500.1, 1000, 30, 1.5, 'urban')).toThrow(PathLossRefusalError);
  });
  it('never falls below free space (near the mast, outside the 1 km validity)', () => {
    const d = 10;
    const fs = freeSpacePathLossDb(900, Math.hypot(d, 30 - 1.5));
    expect(okumuraHataDb(900, d, 30, 1.5, 'urban')).toBeCloseTo(fs, 9);
  });
});

describe('COST-231 Hata', () => {
  it('matches the published formula at 1800 MHz, 30 m, 1.5 m, 1 km', () => {
    const f = 1800;
    const a = (1.1 * log10(f) - 0.7) * 1.5 - (1.56 * log10(f) - 0.8);
    const expected = 46.3 + 33.9 * log10(f) - 13.82 * log10(30) - a;
    expect(cost231HataDb(f, 1000, 30, 1.5, 'urban')).toBeCloseTo(expected, 6);
    expect(expected).toBeCloseTo(136.2, 1);
  });
  it('adds 3 dB in a metropolitan centre (with the large-city a(hm))', () => {
    const f = 1840;
    const aMedium = (1.1 * log10(f) - 0.7) * 1.5 - (1.56 * log10(f) - 0.8);
    const aLarge = 3.2 * log10(11.75 * 1.5) ** 2 - 4.97;
    expect(
      cost231HataDb(f, 3000, 30, 1.5, 'urban-large') - cost231HataDb(f, 3000, 30, 1.5, 'urban'),
    ).toBeCloseTo(3 + aMedium - aLarge, 6);
  });
  it('refuses frequencies outside 1500 to 2000 MHz', () => {
    expect(() => cost231HataDb(760, 1000, 30, 1.5, 'urban')).toThrow(/1500 to 2000 MHz/);
    expect(() => cost231HataDb(2600, 1000, 30, 1.5, 'urban')).toThrow(PathLossRefusalError);
    expect(() => cost231HataDb(2000, 1000, 30, 1.5, 'urban')).not.toThrow();
    expect(COST231_RANGE_MHZ).toEqual([1500, 2000]);
  });
});

describe('38.901 LOS probability (Table 7.4.2-1)', () => {
  it('is 1 up to 18 m (UMa, UMi) and 10 m (RMa)', () => {
    expect(losProbability38901('uma', 18, 1.5)).toBe(1);
    expect(losProbability38901('umi', 10, 1.5)).toBe(1);
    expect(losProbability38901('rma', 10, 1.5)).toBe(1);
  });
  it('follows the published formulas', () => {
    const d = 200;
    expect(losProbability38901('umi', d, 1.5)).toBeCloseTo(
      18 / d + Math.exp(-d / 36) * (1 - 18 / d),
      12,
    );
    expect(losProbability38901('uma', d, 1.5)).toBeCloseTo(
      18 / d + Math.exp(-d / 63) * (1 - 18 / d),
      12,
    );
    expect(losProbability38901('rma', 1010, 1.5)).toBeCloseTo(Math.exp(-1), 12);
    const c = ((20 - 13) / 10) ** 1.5;
    expect(losProbability38901('uma', d, 20)).toBeCloseTo(
      (18 / d + Math.exp(-d / 63) * (1 - 18 / d)) *
        (1 + c * (5 / 4) * (d / 100) ** 3 * Math.exp(-d / 150)),
      12,
    );
  });
});

describe('38.901 path loss (Table 7.4.1-1)', () => {
  it("UMa: breakpoint from effective heights, continuous at d'BP, NLOS never below LOS", () => {
    const r = uma38901(3500, 100, 25, 1.5);
    // d'BP = 4 (25 - 1)(1.5 - 1) 3.5e9 / 3e8 = 560 m
    expect(r.breakpointM).toBeCloseTo(560, 9);
    const d3 = Math.hypot(100, 23.5);
    expect(r.losDb).toBeCloseTo(28 + 22 * log10(d3) + 20 * log10(3.5), 9);
    expect(r.nlosDb).toBeCloseTo(13.54 + 39.08 * log10(d3) + 20 * log10(3.5), 9);
    const below = uma38901(3500, 560 - 1e-9, 25, 1.5);
    const above = uma38901(3500, 560 + 1e-9, 25, 1.5);
    expect(above.losDb - below.losDb).toBeCloseTo(0, 6);
    for (const d of [10, 30, 100, 1000, 5000]) {
      const x = uma38901(1840, d, 25, 1.5);
      expect(x.nlosDb).toBeGreaterThanOrEqual(x.losDb);
    }
  });
  it('expected path loss mixes LOS and NLOS in dB by the LOS probability', () => {
    for (const fn of [uma38901, umi38901, rma38901]) {
      const r = fn(2600, 300, 25, 1.5);
      expect(r.expectedDb).toBeCloseTo(r.pLos * r.losDb + (1 - r.pLos) * r.nlosDb, 9);
    }
  });
  it('UMi: street canyon formulas', () => {
    const r = umi38901(3500, 300, 10, 1.5);
    expect(r.breakpointM).toBeCloseTo((4 * 9 * 0.5 * 3.5e9) / 3e8, 9);
    const d3 = Math.hypot(300, 8.5);
    const los =
      32.4 + 40 * log10(d3) + 20 * log10(3.5) - 9.5 * log10(r.breakpointM ** 2 + 8.5 ** 2);
    expect(r.losDb).toBeCloseTo(los, 9);
    const nlosPrime = 35.3 * log10(d3) + 22.4 + 21.3 * log10(3.5);
    expect(r.nlosDb).toBeCloseTo(Math.max(los, nlosPrime), 9);
  });
  it('RMa: actual-height breakpoint and the PL1(dBP) + 40 log10(d3D/dBP) branch', () => {
    const r = rma38901(760, 3000, 35, 1.5);
    const dbp = (2 * Math.PI * 35 * 1.5 * 0.76e9) / 3e8;
    expect(r.breakpointM).toBeCloseTo(dbp, 9);
    const h = 5;
    const pl1 = (d: number) =>
      20 * log10((40 * Math.PI * d * 0.76) / 3) +
      Math.min(0.03 * h ** 1.72, 10) * log10(d) -
      Math.min(0.044 * h ** 1.72, 14.77) +
      0.002 * log10(h) * d;
    const d3 = Math.hypot(3000, 33.5);
    expect(r.losDb).toBeCloseTo(pl1(dbp) + 40 * log10(d3 / dbp), 9);
  });
  it('clamps distances below 10 m to 10 m', () => {
    expect(uma38901(1840, 0, 25, 1.5).expectedDb).toBeCloseTo(
      uma38901(1840, 10, 25, 1.5).expectedDb,
      12,
    );
  });
  it('refuses a UE at or below the 1 m effective environment height in UMa and UMi', () => {
    const setup = {
      model: 'tr38901',
      environment: 'uma',
      frequencyMHz: 1840,
      hBsM: 25,
      hUtM: 1,
    } as const;
    expect(pathLossRefusal(setup)).toMatchObject({ code: 'height' });
    expect(() => pathLossDb(setup, 100)).toThrow(PathLossRefusalError);
    expect(pathLossRefusal({ ...setup, environment: 'rma' })).toBeNull();
  });
  it('refuses frequencies outside the 38.901 range', () => {
    expect(
      pathLossRefusal({
        model: 'tr38901',
        environment: 'rma',
        frequencyMHz: 40_000,
        hBsM: 35,
        hUtM: 1.5,
      }),
    ).toMatchObject({ code: 'frequency', rangeMHz: [500, 30_000] });
    expect(
      pathLossRefusal({
        model: 'tr38901',
        environment: 'uma',
        frequencyMHz: 400,
        hBsM: 25,
        hUtM: 1.5,
      }),
    ).toMatchObject({ code: 'frequency' });
  });
});

describe('pathLossDb / makePathLoss', () => {
  it('dispatches by model', () => {
    const base = { environment: 'uma', frequencyMHz: 1840, hBsM: 30, hUtM: 1.5 } as const;
    expect(pathLossDb({ ...base, model: 'tr38901' }, 800)).toBeCloseTo(
      uma38901(1840, 800, 30, 1.5).expectedDb,
      12,
    );
    expect(pathLossDb({ ...base, model: 'cost231-hata' }, 800)).toBeCloseTo(
      cost231HataDb(1840, 800, 30, 1.5, 'urban'),
      12,
    );
    expect(pathLossDb({ ...base, model: 'free-space' }, 800)).toBeCloseTo(
      freeSpacePathLossDb(1840, Math.hypot(800, 28.5)),
      12,
    );
    expect(
      pathLossDb({ ...base, model: 'okumura-hata', environment: 'rma', frequencyMHz: 900 }, 800),
    ).toBeCloseTo(okumuraHataDb(900, 800, 30, 1.5, 'open'), 12);
    const fn = makePathLoss({ ...base, model: 'tr38901', environment: 'umi' });
    expect(fn(500)).toBeCloseTo(umi38901(1840, 500, 30, 1.5).expectedDb, 12);
  });
  it('refuses once, when the function is made', () => {
    expect(() =>
      makePathLoss({
        model: 'okumura-hata',
        environment: 'uma',
        frequencyMHz: 2600,
        hBsM: 30,
        hUtM: 1.5,
      }),
    ).toThrow(/150 to 1500 MHz/);
  });
  it('warns, without refusing, outside the validated distances and heights', () => {
    const w = pathLossWarnings(
      { model: 'okumura-hata', environment: 'uma', frequencyMHz: 900, hBsM: 20, hUtM: 1.5 },
      15_000,
    );
    expect(w.map((x) => x.code).sort()).toEqual(['bs-height', 'distance-near']);
    const t = pathLossWarnings(
      { model: 'tr38901', environment: 'uma', frequencyMHz: 1840, hBsM: 25, hUtM: 1.5 },
      8000,
    );
    expect(t.map((x) => x.code)).toEqual(['distance-far']);
  });
});
