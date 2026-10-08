import { describe, expect, it } from 'vitest';
import {
  AREA_FACTORS,
  AREA_UNITS,
  convert,
  DENSITY_FACTORS,
  DENSITY_UNITS,
  DISTANCE_FACTORS,
  DISTANCE_UNITS,
  formatCoordinate,
  formatNumber,
  formatQuantity,
  fromSI,
  gradeFrom,
  gradeIn,
  GRADE_STYLES,
  MASS_FACTORS,
  MASS_UNITS,
  parseQuantity,
  toSI,
  unitLabel,
  unitName,
  unitsForCrsUnit,
  VOLUME_FACTORS,
  VOLUME_UNITS,
} from './units';

const QUANTITIES = [
  ['distance', DISTANCE_UNITS],
  ['area', AREA_UNITS],
  ['volume', VOLUME_UNITS],
  ['density', DENSITY_UNITS],
  ['mass', MASS_UNITS],
] as const;

describe('unit factors', () => {
  it('defines the two feet exactly and apart', () => {
    expect(DISTANCE_FACTORS.ft).toBe(0.3048);
    expect(DISTANCE_FACTORS['us-ft']).toBe(1200 / 3937);
    // 2 ppm: 2 cm over 10 km
    expect(
      (10_000 / DISTANCE_FACTORS.ft - 10_000 / DISTANCE_FACTORS['us-ft']) * 0.3048,
    ).toBeCloseTo(0.02, 3);
    expect(unitLabel('ft')).not.toBe(unitLabel('us-ft'));
    expect(unitName('ft')).toBe('ft (international)');
    expect(unitLabel('us-ft')).toBe('US ft');
  });

  it('derives every imperial unit from its definition', () => {
    expect(DISTANCE_FACTORS.in).toBe(0.0254);
    expect(DISTANCE_FACTORS.yd).toBe(0.9144);
    expect(DISTANCE_FACTORS.mi).toBe(1609.344);
    expect(DISTANCE_FACTORS['us-mi']).toBeCloseTo(1609.3472186944373, 10);
    expect(AREA_FACTORS.acre).toBeCloseTo(4046.8564224, 9);
    expect(AREA_FACTORS.ha).toBe(10_000);
    expect(AREA_FACTORS['us-ft2']).toBe((1200 / 3937) ** 2);
    expect(VOLUME_FACTORS['us-gal']).toBeCloseTo(0.003785411784, 15);
    expect(VOLUME_FACTORS['acre-ft']).toBeCloseTo(1233.48183754752, 9);
    expect(VOLUME_FACTORS.yd3).toBeCloseTo(0.764554857984, 15);
    expect(MASS_FACTORS.lb).toBe(0.45359237);
    expect(MASS_FACTORS.ston).toBeCloseTo(907.18474, 10);
    expect(DENSITY_FACTORS['kg/m3']).toBe(0.001);
    // 1 lb/ft3 is 16.018 463 373 960 1 kg/m3
    expect(DENSITY_FACTORS['lb/ft3'] * 1000).toBeCloseTo(16.0184633739601, 12);
    expect(DENSITY_FACTORS['ston/yd3']).toBeCloseTo(1.1865528425, 9);
  });

  it('round-trips every pair of units of every quantity', () => {
    const values = [0, 1, -3.25, 0.001, 1234567.891, 1e-9];
    for (const [q, units] of QUANTITIES) {
      for (const a of units) {
        for (const b of units) {
          for (const v of values) {
            const back = convert(convert(v, q, a, b), q, b, a);
            expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.abs(v) * 1e-14 + 1e-20);
          }
        }
        expect(toSI(fromSI(42.5, q, a), q, a)).toBeCloseTo(42.5, 12);
      }
    }
  });

  it('refuses a unit of the wrong quantity', () => {
    expect(() => toSI(1, 'distance', 'm2')).toThrow('not a distance unit');
  });
});

describe('grades', () => {
  it('converts every style both ways', () => {
    for (const g of [0.05, -0.05, 0.5, 1, 0.001]) {
      for (const s of GRADE_STYLES) {
        const back = gradeFrom(gradeIn(g, s), s);
        expect(back).toBeCloseTo(s.startsWith('ratio') ? Math.abs(g) : g, 12);
      }
    }
    expect(gradeIn(0.05, 'percent')).toBeCloseTo(5, 12);
    expect(gradeIn(1, 'degrees')).toBeCloseTo(45, 12);
    expect(gradeIn(0.05, 'ratio-1-n')).toBeCloseTo(20, 12);
  });
});

describe('formatQuantity', () => {
  it('groups thousands with a space for metric and a comma for imperial', () => {
    expect(formatNumber(1234567.891, 2)).toBe('1 234 567.89');
    expect(formatNumber(1234567.891, 2, 'imperial')).toBe('1,234,567.89');
    expect(formatNumber(-0.0004, 3)).toBe('0.000');
    expect(formatNumber(-1234.5, 1)).toBe('-1 234.5');
  });

  it('formats in the site units and precision', () => {
    const site = { distance: 'us-ft', area: 'acre', volume: 'yd3' } as const;
    expect(formatQuantity(12.3456, 'distance', site, 2)).toBe('40.50 US ft');
    expect(formatQuantity(12.3456, 'distance', 'ft', 3)).toBe('40.504 ft');
    expect(formatQuantity(4046.8564224, 'area', site, { area: 3 })).toBe('1.000 ac');
    expect(formatQuantity(1000, 'volume', site, 0)).toBe('1,308 yd³');
    expect(formatQuantity(1000, 'volume', 'm3', 1)).toBe('1 000.0 m³');
    expect(formatQuantity(1.85, 'density', 't/m3', { volume: 1 })).toBe('1.85 t/m³');
    expect(formatQuantity(1000, 'mass', 't', 2)).toBe('1.00 t');
    expect(formatQuantity(0.05, 'grade', 'percent', 1)).toBe('5.0 %');
    expect(formatQuantity(-0.05, 'grade', 'ratio-1-n', 0)).toBe('-1:20');
    expect(formatQuantity(1 / 3, 'grade', 'ratio-n-1', 1)).toBe('3.0:1');
    expect(formatQuantity(0, 'grade', 'ratio-1-n', 0)).toBe('1:∞');
    expect(formatQuantity(1, 'grade', 'degrees', 1)).toBe('45.0°');
    expect(formatQuantity(3179597.123, 'coordinate', site, { coordinate: 3 })).toBe(
      '10,431,728.228',
    );
    expect(formatQuantity(1234.5, 'distance', 'm', 1, 'imperial')).toBe('1,234.5 m');
  });

  it('formats coordinates in the site order', () => {
    const style = { order: 'NEZ', units: { distance: 'm' }, precision: { coordinate: 3 } } as const;
    expect(formatCoordinate(245884.94, 3179597.12, 12.3, style)).toBe(
      'N 3 179 597.120  E 245 884.940  Z 12.300 m',
    );
    expect(formatCoordinate(245884.94, 3179597.12, null, { ...style, order: 'ENZ' })).toBe(
      'E 245 884.940  N 3 179 597.120',
    );
  });
});

describe('parseQuantity', () => {
  it('reads a bare number in the default unit', () => {
    expect(parseQuantity('12.5', 'distance', 'm')).toEqual({ ok: true, value: 12.5, unit: 'm' });
    const r = parseQuantity('100', 'distance', 'us-ft');
    expect(r.ok && r.value).toBe(100 * (1200 / 3937));
  });

  it('reads typed units, grouped thousands and feet and inches', () => {
    const v = (text: string, q: Parameters<typeof parseQuantity>[1], d: string) => {
      const r = parseQuantity(text, q, d as Parameters<typeof parseQuantity>[2]);
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    expect(v('12.5 ft', 'distance', 'm').value).toBeCloseTo(3.81, 12);
    expect(v('40 US ft', 'distance', 'm').unit).toBe('us-ft');
    expect(v('12\' 6"', 'distance', 'm').value).toBeCloseTo(12.5 * 0.3048, 12);
    expect(v('1,234.5 m2', 'area', 'ha').value).toBeCloseTo(1234.5, 12);
    expect(v('1 234.5 m²', 'area', 'ha').value).toBeCloseTo(1234.5, 12);
    expect(v('2 ha', 'area', 'm2').value).toBe(20_000);
    expect(v('3 ac', 'area', 'm2').value).toBeCloseTo(3 * 4046.8564224, 9);
    expect(v('500 cu yd', 'volume', 'm3').value).toBeCloseTo(500 * 0.764554857984, 9);
    expect(v('1850 kg/m3', 'density', 't/m3').value).toBeCloseTo(1.85, 12);
    expect(v('2 sh tn', 'mass', 'kg').value).toBeCloseTo(1814.36948, 9);
  });

  it('reads grades in every style', () => {
    const g = (text: string, style: 'percent' | 'degrees' | 'ratio-1-n' | 'ratio-n-1') => {
      const r = parseQuantity(text, 'grade', style);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    expect(g('5', 'percent')).toBeCloseTo(0.05, 12);
    expect(g('5 %', 'degrees')).toBeCloseTo(0.05, 12);
    expect(g('45°', 'percent')).toBeCloseTo(1, 12);
    expect(g('1:20', 'ratio-1-n')).toBeCloseTo(0.05, 12);
    expect(g('20:1', 'ratio-n-1')).toBeCloseTo(0.05, 12);
    expect(g('-1:4', 'ratio-1-n')).toBeCloseTo(-0.25, 12);
  });

  it('says what is wrong', () => {
    expect(parseQuantity('', 'distance', 'm')).toMatchObject({ ok: false });
    expect(parseQuantity('abc', 'distance', 'm')).toMatchObject({ ok: false });
    expect(parseQuantity('12 parsecs', 'distance', 'm')).toMatchObject({
      ok: false,
      error: '"parsecs" is not a distance unit.',
    });
    expect(parseQuantity('12 m2', 'distance', 'm')).toMatchObject({ ok: false });
    expect(parseQuantity('90°', 'grade', 'degrees')).toMatchObject({ ok: false });
    expect(parseQuantity('1:0', 'grade', 'ratio-1-n')).toMatchObject({ ok: false });
  });
});

describe('unitsForCrsUnit', () => {
  it('gives US survey feet to a CRS in US survey feet (decision 12)', () => {
    expect(unitsForCrsUnit('US survey foot').distance).toBe('us-ft');
    expect(unitsForCrsUnit('foot').distance).toBe('ft');
    expect(unitsForCrsUnit('metre').distance).toBe('m');
    expect(unitsForCrsUnit(undefined).distance).toBe('m');
  });
});
