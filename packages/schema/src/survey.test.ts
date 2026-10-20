import { describe, expect, it } from 'vitest';
import {
  Capture,
  ComparisonResult,
  DEFAULT_ANGLES,
  MeasurementsFile,
  SurveySettings,
  defaultSurveySettings,
} from './index';

const result = {
  item: 'cmp-1',
  status: 'ok',
  cutM3: 12.5,
  fillM3: 40,
  netM3: 27.5,
  totalM3: 52.5,
  areaM2: 200,
  areaCutM2: 60,
  areaFillM2: 120,
  areaUnchangedM2: 20,
  uncoveredM2: 0,
  fromLabel: 'Survey A',
  toLabel: 'Survey B',
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0,
  engine: 'ts',
  fingerprint: 'fp-1',
  computedAt: '2026-10-20T08:00:00Z',
};

const measurement = {
  id: 'm-1',
  family: 'polygon',
  tool: 'volume',
  label: 'Stockpile A',
  scope: { kind: 'survey', capture: 'c1' },
  points: [[500000, 2900000, 10]],
  items: [],
  results: [result],
  createdAt: '2026-10-20T08:00:00Z',
};

describe('volumetric parity contracts', () => {
  it('parses a measurement with origin, series and previous results', () => {
    const file = {
      schema: 'aio.measurements/1',
      kitPilesConverted: ['Pile 1'],
      measurements: [
        {
          ...measurement,
          origin: { kind: 'kit-pile', pile: 'Pile 1' },
          series: [result, result],
          previousResults: [
            { netM3: 1, totalM3: 2, label: 'Before', replacedAt: '2026-10-20T09:00:00Z' },
          ],
        },
      ],
    };
    const parsed = MeasurementsFile.parse(file);
    expect(parsed.kitPilesConverted).toEqual(['Pile 1']);
    expect(parsed.measurements[0]?.series).toHaveLength(2);
    expect(parsed.measurements[0]?.origin).toEqual({ kind: 'kit-pile', pile: 'Pile 1' });
  });

  it('an older measurement without the new fields still parses', () => {
    const parsed = MeasurementsFile.parse({
      schema: 'aio.measurements/1',
      measurements: [measurement],
    });
    expect(parsed.measurements[0]?.origin).toBeUndefined();
    expect(parsed.kitPilesConverted).toBeUndefined();
  });

  it('a result with carried kit figures parses and keeps carried.base', () => {
    const carried = { from: 'kit', base: 'plane', pile: 'Pile 1', epoch: 'e1' };
    const r = ComparisonResult.parse({
      ...result,
      carried,
      uncertainty: { plusMinusM3: 3, sigmaM: 0.05, source: 'checkpoints' },
    });
    expect(r.carried?.base).toBe('plane');
    expect(
      ComparisonResult.safeParse({ ...result, carried: { ...carried, base: 'nope' } }).success,
    ).toBe(false);
  });

  it('settings without angles parse; DEFAULT_ANGLES is deg, dms, 2', () => {
    expect(SurveySettings.parse(defaultSurveySettings()).angles).toBeUndefined();
    expect(DEFAULT_ANGLES).toEqual({ angle: 'deg', bearing: 'dms', precision: 2 });
    expect(
      SurveySettings.parse({ ...defaultSurveySettings(), angles: DEFAULT_ANGLES }).angles,
    ).toEqual(DEFAULT_ANGLES);
  });

  it('a capture carries an optional vertical accuracy', () => {
    const base = { id: 'c1', label: 'A', date: '2026-10-20' };
    expect(Capture.parse(base).verticalAccuracy).toBeUndefined();
    expect(
      Capture.parse({ ...base, verticalAccuracy: { sigmaM: 0.04, source: 'rtk' } })
        .verticalAccuracy,
    ).toEqual({ sigmaM: 0.04, source: 'rtk' });
  });
});
