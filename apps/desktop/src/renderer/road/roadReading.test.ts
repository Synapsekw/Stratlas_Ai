import { lineLengthM, polygonAreaM2 } from '@aio/maps';
import { defaultSurveySettings, type SurveySettings } from '@aio/schema';
import { formatRow, lineMetrics, polygonAreas, type ReadoutRow } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import { roadReading } from './roadReading';

const settings = defaultSurveySettings();
// a few hundred metres across, near 45 N
const line: [number, number][] = [
  [8.0, 45.0],
  [8.002, 45.001],
  [8.004, 45.0015],
];
const ring: [number, number][] = [
  [8.0, 45.0],
  [8.004, 45.0],
  [8.004, 45.003],
  [8.0, 45.003],
];

describe('roadReading', () => {
  it('road distance is the geodesic length of the same points, as lineMetrics horizontal', () => {
    const r = roadReading('line', line, settings);
    expect(r).not.toBeNull();
    // the survey tools on the same length laid out in metres
    const m = lineLengthM(line);
    const horizontalM = lineMetrics(
      [
        [0, 0, 0],
        [m, 0, 0],
      ],
      undefined,
    ).horizontalM;
    const row: ReadoutRow = {
      key: 'horizontal',
      label: 'Horizontal length',
      value: horizontalM,
      kind: 'distance',
    };
    // the map's geodesic length and the tangent plane agree to well under a tenth of a percent
    const shown = formatRow(row, settings.units, settings.precision);
    expect(r?.primary).toMatch(/ m$/);
    expect(Math.abs(Number.parseFloat(r?.primary ?? '') - m) / m).toBeLessThan(1e-3);
    expect(Number.parseFloat(shown)).toBeCloseTo(m, 2);
    expect(r?.secondary).toBe('');
  });

  it('road area in acres with imperial settings', () => {
    const imperial: SurveySettings = {
      ...settings,
      units: { ...settings.units, distance: 'ft', area: 'acre' },
    };
    const r = roadReading('polygon', ring, imperial);
    const side = Math.sqrt(polygonAreaM2(ring));
    const flat = polygonAreas(
      [
        [0, 0, 0],
        [side, 0, 0],
        [side, side, 0],
        [0, side, 0],
      ],
      undefined,
    ).horizontalM2;
    const row: ReadoutRow = { key: 'area', label: 'Horizontal area', value: flat, kind: 'area' };
    expect(r?.primary).toBe(formatRow(row, imperial.units, imperial.precision));
    expect(r?.primary).toMatch(/ac/);
    // the perimeter reads on the second line, in feet
    expect(r?.secondary).toMatch(/ft/);
  });

  it('gives nothing with too few points', () => {
    expect(roadReading('line', line.slice(0, 1), settings)).toBeNull();
    expect(roadReading('polygon', ring.slice(0, 2), settings)).toBeNull();
  });
});
