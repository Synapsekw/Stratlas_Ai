import type { AntennaUnit, AntennaValue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { azimuthLines, formatDeg, qualityTip, trueAzimuth } from './antennaFormat';

const v = (value: number): AntennaValue => ({
  value,
  basis: 'measured',
  quality: { basis: 'measured', residualM: 0.003, support: 812, coverage: 0.74 },
});
const unit = (over: Partial<AntennaUnit>): AntennaUnit =>
  ({
    id: 'ant-1',
    name: 'A1',
    kind: 'panel',
    kindBasis: 'geometry',
    status: 'draft',
    convergenceDeg: null,
    ...over,
  }) as AntennaUnit;

describe('antennaFormat', () => {
  it('adds convergence for true north and wraps', () => {
    expect(trueAzimuth(359.5, 1.0)).toBeCloseTo(0.5);
    expect(trueAzimuth(0.5, -1.0)).toBeCloseTo(359.5);
  });
  it('formats degrees with an optional sign', () => {
    expect(formatDeg(123.44)).toBe('123.4°');
    expect(formatDeg(3, true)).toBe('+3.0°');
    expect(formatDeg(-2.5, true)).toBe('-2.5°');
  });
  it('labels project north when convergence is null', () => {
    expect(azimuthLines(unit({ azimuthGridDeg: v(123.4), convergenceDeg: null }))).toEqual({
      primary: 'Project north 123.4°',
      secondary: null,
    });
  });
  it('shows true first and grid second when convergence is known', () => {
    expect(azimuthLines(unit({ azimuthGridDeg: v(123.4), convergenceDeg: 1.2 }))).toEqual({
      primary: 'True 124.6°',
      secondary: 'Grid 123.4°',
    });
  });
  it('has no azimuth lines for a unit without one', () => {
    expect(azimuthLines(unit({ kind: 'other' }))).toBeNull();
  });
  it('words the fit quality, falling back to the note then the basis', () => {
    expect(qualityTip(v(1))).toBe('Fit residual 3.0 mm, 812 points, 74% coverage');
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
