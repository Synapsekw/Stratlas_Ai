import type { AntennaValue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { formatAngle, formatHeight, formatSize, qualityTip, trueAzimuth } from './antennaFormat';

const v = (value: number): AntennaValue => ({
  value,
  basis: 'measured',
  quality: { basis: 'measured', residualM: 0.003, support: 812, coverage: 0.74 },
});

describe('antennaFormat', () => {
  it('adds convergence for true north and wraps', () => {
    expect(trueAzimuth(359.5, 1.0)).toBeCloseTo(0.5);
    expect(trueAzimuth(0.5, -1.0)).toBeCloseTo(359.5);
  });
  it('writes an angle and a height to one decimal and a size to two, in metres', () => {
    expect(formatAngle(7.25)).toBe('7.3°');
    expect(formatAngle(2, true)).toBe('+2.0°');
    expect(formatAngle(-0.01, true)).toBe('+0.0°');
    expect(formatHeight(31.46)).toBe('31.5 m');
    expect(formatHeight(31.46, false)).toBe('31.5');
    expect(formatHeight(-0.04)).toBe('0.0 m');
    expect(formatSize(1.304)).toBe('1.30 m');
    expect(formatSize(0.256, false)).toBe('0.26');
  });
  it('writes an azimuth that rounds up to 360 as 0, as the Sectors group does', () => {
    expect(formatAngle(359.96)).toBe('0.0°');
    expect(formatAngle(359.94)).toBe('359.9°');
    expect(formatAngle(360)).toBe('0.0°');
  });
  it('words the fit quality, falling back to the note then the basis', () => {
    expect(qualityTip(v(1))).toBe('Fit residual 3.0 mm, 812 points, 74% of the face with points');
    expect(
      qualityTip({
        value: 1,
        basis: 'inferred',
        quality: { basis: 'inferred', note: 'From shape' },
      }),
    ).toBe('From shape');
    expect(qualityTip({ value: 1, basis: 'user', quality: { basis: 'user' } })).toBe(
      'Entered by you',
    );
  });
});
