import { describe, expect, it } from 'vitest';
import {
  Capture,
  ComparisonResult,
  DEFAULT_ANGLES,
  MeasurementsFile,
  SiteMaterial,
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

  it('kitHeightsRepaired round-trips and is optional', () => {
    const file = {
      schema: 'aio.measurements/1',
      kitPilesConverted: ['Pile 1'],
      kitHeightsRepaired: ['m-1'],
      measurements: [measurement],
    };
    const parsed = MeasurementsFile.parse(file);
    expect(parsed.kitHeightsRepaired).toEqual(['m-1']);
    expect(parsed).toEqual(file);
    const without = MeasurementsFile.parse({ schema: 'aio.measurements/1', measurements: [] });
    expect(without.kitHeightsRepaired).toBeUndefined();
    expect(
      MeasurementsFile.safeParse({
        schema: 'aio.measurements/1',
        measurements: [],
        kitHeightsRepaired: 'm-1',
      }).success,
    ).toBe(false);
    expect(
      MeasurementsFile.safeParse({
        schema: 'aio.measurements/1',
        measurements: [],
        kitHeightsRepaired: Array.from({ length: 5001 }, (_, i) => `m-${i}`),
      }).success,
    ).toBe(false);
  });

  it('a result with carried kit figures parses and keeps carried.base', () => {
    const carried = { from: 'kit', base: 'plane', pile: 'Pile 1', epoch: 'e1' };
    const r = ComparisonResult.parse({
      ...result,
      carried,
      uncertainty: { plusMinusM3: 3, sigmaM: 0.05, source: 'checkpoints' },
    });
    expect(r.carried?.base).toBe('plane');
    // a base a later build adds still opens here (the name is resolved at display)
    expect(
      ComparisonResult.parse({ ...result, carried: { ...carried, base: 'later-base' } }).carried
        ?.base,
    ).toBe('later-base');
    expect(
      ComparisonResult.safeParse({ ...result, carried: { ...carried, base: '' } }).success,
    ).toBe(false);
    expect(
      ComparisonResult.safeParse({ ...result, carried: { ...carried, base: 'x'.repeat(41) } })
        .success,
    ).toBe(false);
  });

  it('settings without angles parse; DEFAULT_ANGLES is deg, dms, 2', () => {
    expect(SurveySettings.parse(defaultSurveySettings()).angles).toBeUndefined();
    expect(DEFAULT_ANGLES).toEqual({ angle: 'deg', bearing: 'dms', precision: 2 });
    expect(
      SurveySettings.parse({ ...defaultSurveySettings(), angles: DEFAULT_ANGLES }).angles,
    ).toEqual(DEFAULT_ANGLES);
  });

  it('accuracy objects keep keys and sources a later build adds', () => {
    const va = { sigmaM: 0.04, source: 'rtk', basis: 'later' };
    const cap = Capture.parse({ id: 'c1', label: 'A', date: '2026-10-20', verticalAccuracy: va });
    expect(cap.verticalAccuracy).toEqual(va);
    const u = { plusMinusM3: 3, sigmaM: 0.05, source: 'ppk', extra: 1 };
    expect(ComparisonResult.parse({ ...result, uncertainty: u }).uncertainty).toEqual(u);
    const later = { ...u, source: 'lidar-strip' };
    expect(ComparisonResult.parse({ ...result, uncertainty: later }).uncertainty).toEqual(later);
    expect(
      Capture.parse({
        id: 'c1',
        label: 'A',
        date: '2026-10-20',
        verticalAccuracy: { ...va, source: 'later' },
      }).verticalAccuracy?.source,
    ).toBe('later');
    expect(
      ComparisonResult.safeParse({ ...result, uncertainty: { ...u, source: '' } }).success,
    ).toBe(false);
    expect(
      ComparisonResult.safeParse({ ...result, uncertainty: { ...u, source: 'x'.repeat(41) } })
        .success,
    ).toBe(false);
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

describe('site material colour and dated density', () => {
  const material = { id: 'mat-1', name: 'Aggregate', densityTPerM3: 1.6 };

  it('colour accepts #rrggbb only', () => {
    expect(SiteMaterial.safeParse({ ...material, colour: '#a1B2c3' }).success).toBe(true);
    for (const colour of ['#abc', 'a1b2c3', '#a1b2c3d4', 'red', '#g1b2c3', '']) {
      expect(SiteMaterial.safeParse({ ...material, colour }).success).toBe(false);
    }
  });

  it('densityHistory rejects a repeated capture', () => {
    const ok = SiteMaterial.safeParse({
      ...material,
      densityHistory: [
        { fromCapture: 'cap-1', tPerM3: 1.5 },
        { fromCapture: 'cap-2', tPerM3: 1.6 },
      ],
    });
    expect(ok.success).toBe(true);
    const repeated = SiteMaterial.safeParse({
      ...material,
      densityHistory: [
        { fromCapture: 'cap-1', tPerM3: 1.5 },
        { fromCapture: 'cap-1', tPerM3: 1.6 },
      ],
    });
    expect(repeated.success).toBe(false);
  });

  it('densityHistory bounds each density and the entry count', () => {
    const one = (tPerM3: number) =>
      SiteMaterial.safeParse({ ...material, densityHistory: [{ fromCapture: 'cap-1', tPerM3 }] })
        .success;
    expect(one(30)).toBe(true);
    expect(one(0)).toBe(false);
    expect(one(-1)).toBe(false);
    expect(one(30.1)).toBe(false);
    const many = (n: number) =>
      SiteMaterial.safeParse({
        ...material,
        densityHistory: Array.from({ length: n }, (_, i) => ({
          fromCapture: `cap-${i}`,
          tPerM3: 1.5,
        })),
      }).success;
    expect(many(100)).toBe(true);
    expect(many(101)).toBe(false);
  });

  it('a material without the new fields still parses', () => {
    const parsed = SiteMaterial.parse(material);
    expect(parsed).toEqual(material);
    expect(parsed.colour).toBeUndefined();
    expect(parsed.densityHistory).toBeUndefined();
  });
});
