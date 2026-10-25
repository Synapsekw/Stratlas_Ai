import { describe, expect, it } from 'vitest';
import { MeasurementOutline, MeasurementsFile, SurveyMeasurement } from './survey';

const ring = (z: number): [number, number, number][] => [
  [500000, 2900000, z],
  [500010, 2900000, z],
  [500010, 2900010, z],
];

const measurement = {
  id: 'm-1',
  family: 'polygon',
  tool: 'volume',
  label: 'Stockpile A',
  scope: { kind: 'site' },
  points: ring(10),
  items: [],
  results: [],
  createdAt: '2026-10-20T08:00:00Z',
};

describe('per-date outlines', () => {
  it('parses one outline per capture on a measurement', () => {
    const m = {
      ...measurement,
      outlines: [
        { capture: 'c1', points: ring(10) },
        { capture: 'c2', points: ring(11) },
      ],
    };
    const parsed = SurveyMeasurement.parse(m);
    expect(parsed.outlines?.map((o) => o.capture)).toEqual(['c1', 'c2']);
    expect(SurveyMeasurement.safeParse(measurement).success).toBe(true);
  });

  it('refuses an outline of fewer than three vertices', () => {
    expect(
      MeasurementOutline.safeParse({ capture: 'c1', points: ring(1).slice(0, 2) }).success,
    ).toBe(false);
    expect(MeasurementOutline.safeParse({ capture: 'c1', points: ring(1) }).success).toBe(true);
  });

  it('refuses two outlines for the same capture', () => {
    const m = {
      ...measurement,
      outlines: [
        { capture: 'c1', points: ring(10) },
        { capture: 'c1', points: ring(11) },
      ],
    };
    expect(SurveyMeasurement.safeParse(m).success).toBe(false);
  });

  it('keeps at most 1000 outlines', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ capture: `c${String(i)}`, points: ring(1) }));
    expect(SurveyMeasurement.safeParse({ ...measurement, outlines: many(1000) }).success).toBe(
      true,
    );
    expect(SurveyMeasurement.safeParse({ ...measurement, outlines: many(1001) }).success).toBe(
      false,
    );
  });

  it('reads a file with kitOutlinesAdded and an older file without it', () => {
    const older = { schema: 'aio.measurements/1', measurements: [measurement] };
    expect(MeasurementsFile.safeParse(older).success).toBe(true);
    const parsed = MeasurementsFile.parse({ ...older, kitOutlinesAdded: ['m-1'] });
    expect(parsed.kitOutlinesAdded).toEqual(['m-1']);
    expect(
      MeasurementsFile.safeParse({
        ...older,
        kitOutlinesAdded: [...Array(5001).keys()].map(String),
      }).success,
    ).toBe(false);
  });
});
