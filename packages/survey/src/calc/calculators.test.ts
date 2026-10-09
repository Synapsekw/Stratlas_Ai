import { formatQuantity } from '@aio/geo';
import { describe, expect, it } from 'vitest';
import {
  achievedDensity,
  DENSITY_DECIMALS,
  materialReadout,
  swellVolumes,
  toBank,
  tonnesFrom,
} from './calculators';

describe('calculators (display time, never stored)', () => {
  it('weight: the landfill example, 63,000 t over 70,104 m3, is 0.899 t/m3 as displayed', () => {
    const d = achievedDensity(63_000, 70_104);
    expect(d).toBe(63_000 / 70_104);
    expect(formatQuantity(d ?? 0, 'density', { density: 't/m3' }, DENSITY_DECIMALS)).toBe(
      '0.899 t/m³',
    );
    expect(achievedDensity(10, 0)).toBeNull();
  });

  it('density: tonnes from a volume', () => {
    expect(tonnesFrom(1000, 1.8)).toBe(1800);
    expect(() => tonnesFrom(1000, 0)).toThrow(RangeError);
  });

  it('shrink and swell: bank to loose and compacted and back', () => {
    const v = swellVolumes(1000, { loose: 1.25, compacted: 0.9 });
    expect(v).toEqual({ bankM3: 1000, looseM3: 1250, compactedM3: 900 });
    expect(toBank(1250, 'looseM3', { loose: 1.25, compacted: 0.9 })).toBe(1000);
    expect(toBank(900, 'compactedM3', { loose: 1.25, compacted: 0.9 })).toBe(1000);
    expect(() => swellVolumes(1, { loose: 0, compacted: 1 })).toThrow(RangeError);
  });

  it('a material readout leaves out what the material does not give', () => {
    const r = materialReadout(500, { densityTPerM3: 2 }, 900);
    expect(r).toEqual({
      bankM3: 500,
      looseM3: null,
      compactedM3: null,
      tonnes: 1000,
      achievedTPerM3: 1.8,
    });
    const s = materialReadout(500, { swell: { loose: 1.2, compacted: 0.95 } });
    expect(s.looseM3).toBe(600);
    expect(s.compactedM3).toBe(475);
    expect(s.tonnes).toBeNull();
    expect(materialReadout(500, null).achievedTPerM3).toBeNull();
  });
});
