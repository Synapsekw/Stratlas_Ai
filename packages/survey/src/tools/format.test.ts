import { defaultSurveySettings } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  AREA_FACTORS,
  DISTANCE_FACTORS,
  effectiveUnits,
  formatGrade,
  formatNumber,
  formatQuantity,
  fromSi,
  toSi,
  UNIT_LABELS,
  VOLUME_FACTORS,
} from './format';
import { formatBearing, formatRow } from './readout';

const { units, precision } = defaultSurveySettings();

describe('units adapter', () => {
  it('keeps the international and US survey feet distinct and exact', () => {
    expect(DISTANCE_FACTORS.ft).toBe(0.3048);
    expect(DISTANCE_FACTORS['us-ft']).toBe(1200 / 3937);
    // 2 ppm apart: 2 cm over 10 km
    const tenKm = 10_000;
    expect(fromSi(tenKm, 'distance', 'ft') - fromSi(tenKm, 'distance', 'us-ft')).toBeCloseTo(
      0.0656,
      4,
    );
    expect(UNIT_LABELS.ft).not.toBe(UNIT_LABELS['us-ft']);
    expect(AREA_FACTORS['us-ft2']).toBe((1200 / 3937) ** 2);
    expect(AREA_FACTORS.acre).toBeCloseTo(4046.8564224, 10);
    expect(VOLUME_FACTORS.yd3).toBeCloseTo(0.764554857984, 15);
    expect(VOLUME_FACTORS['acre-ft']).toBeCloseTo(1233.48183754752, 9);
  });

  it('round-trips every unit', () => {
    for (const [unit] of Object.entries(DISTANCE_FACTORS))
      expect(toSi(fromSi(123.456, 'distance', unit), 'distance', unit)).toBeCloseTo(123.456, 12);
  });

  it('groups thousands by locale and never prints -0', () => {
    expect(formatNumber(1234567.891, 2, 'imperial')).toBe('1,234,567.89');
    expect(formatNumber(1234567.891, 1, 'metric')).toBe('1 234 567.9');
    expect(formatNumber(-0.0001, 2, 'metric')).toBe('0.00');
    expect(formatNumber(-12.5, 1, 'metric')).toBe('-12.5');
  });

  it('formats grades as percent, degrees and both ratios', () => {
    expect(formatGrade(0.05, 'percent', 1)).toBe('5.0 %');
    expect(formatGrade(1, 'degrees', 1)).toBe('45.0°');
    expect(formatGrade(0.5, 'ratio-1-n', 1)).toBe('1:2.0');
    expect(formatGrade(-0.5, 'ratio-n-1', 1)).toBe('-2.0:1');
    expect(formatGrade(0, 'ratio-1-n', 1)).toBe('flat');
  });

  it('formats a measurement in its own units over the site units', () => {
    const own = effectiveUnits(units, { distance: 'us-ft', volume: 'yd3' });
    expect(own.area).toBe('m2');
    // 328.0833 US survey feet against 328.0840 international feet
    expect(formatQuantity(100, 'distance', own, precision)).toBe('328.083 US ft');
    expect(formatQuantity(100, 'distance', { ...own, distance: 'ft' }, precision)).toBe(
      '328.084 ft',
    );
    expect(formatQuantity(100, 'distance', units, precision)).toBe('100.000 m');
    expect(formatQuantity(1000, 'volume', own, precision)).toBe('1,308.0 yd³');
  });

  it('formats bearings and readout rows', () => {
    expect(formatBearing(45.5)).toBe('045°30\'00"');
    expect(formatBearing(359.99999)).toBe('000°00\'00"');
    expect(
      formatRow(
        { key: 'cut', label: 'Cut', value: null, kind: 'volume', note: 'n/a' },
        units,
        precision,
      ),
    ).toBe('n/a');
  });
});
