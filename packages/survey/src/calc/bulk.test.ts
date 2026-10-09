import type { ComparisonResult, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { bulkTotals, setSideForAll, setUnitsForAll } from './bulk';

const result = (item: string, cut: number, fill: number, status: ComparisonResult['status']) =>
  ({
    item,
    status,
    cutM3: cut,
    fillM3: fill,
    netM3: fill - cut,
    totalM3: fill + cut,
    areaM2: 100,
    areaCutM2: 0,
    areaFillM2: 0,
    areaUnchangedM2: 0,
    uncoveredM2: 0,
    fromLabel: 'a',
    toLabel: 'b',
    deadbandM: 0,
    usedDeadband: false,
    cellM: 0.5,
    engine: 'ts',
    fingerprint: 'sha256:x',
    computedAt: '2026-10-09T00:00:00Z',
  }) satisfies ComparisonResult;

const pile = (id: string, results: ComparisonResult[]): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  template: 'stockpile',
  label: id,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [
    {
      id: 'pile',
      label: 'Pile',
      from: { kind: 'smart' },
      to: { kind: 'current' },
      useDeadband: false,
    },
    { id: 'chg', from: { kind: 'previous' }, to: { kind: 'current' }, useDeadband: false },
  ],
  results,
  createdAt: '2026-10-09T00:00:00Z',
});

describe('bulk totals', () => {
  it('adds current results per item and counts the rest as missing', () => {
    const a = pile('a', [result('pile', 1, 100, 'ok'), result('chg', 5, 20, 'partial')]);
    const b = pile('b', [result('pile', 2, 50, 'ok'), result('chg', 1, 1, 'stale')]);
    const c = pile('c', [result('pile', 0, 25, 'refused')]);
    const t = bulkTotals([a, b, c], () => 50);
    expect(t.template).toBe('stockpile');
    expect(t.measurements).toBe(3);
    expect(t.areaM2).toBe(150);
    expect(t.rows[0]).toMatchObject({
      label: 'Pile',
      cutM3: 3,
      fillM3: 150,
      netM3: 147,
      totalM3: 153,
      counted: 2,
      missing: 1,
    });
    expect(t.rows[1]).toMatchObject({ label: 'Comparison 2', fillM3: 20, counted: 1, missing: 2 });
    expect(bulkTotals([a, { ...b, template: 'other' }], () => 0).mixed).toBe(true);
    // a fingerprint check can rule a result out too
    expect(
      bulkTotals(
        [a],
        () => 0,
        () => false,
      ).rows[0]?.missing,
    ).toBe(1);
  });

  it('changes a surface for all, marking those results stale, and never puts a base on both sides', () => {
    const a = pile('a', [result('pile', 1, 100, 'ok')]);
    const [n] = setSideForAll([a], 0, 'to', { kind: 'survey', surface: 'd2' });
    expect(n?.items[0]?.to).toEqual({ kind: 'survey', surface: 'd2' });
    expect(n?.results[0]?.status).toBe('stale');
    const [same] = setSideForAll([a], 0, 'to', { kind: 'fit-plane' });
    expect(same).toBe(a);
    const [none] = setSideForAll([a], 5, 'to', { kind: 'current' });
    expect(none).toBe(a);
  });

  it('sets the units of all, or puts them back to the site units', () => {
    const a = pile('a', []);
    const [u] = setUnitsForAll([a], { volume: 'yd3', distance: undefined });
    expect(u?.units).toEqual({ volume: 'yd3' });
    const [s] = setUnitsForAll([{ ...a, units: { volume: 'yd3' } }], {});
    expect(s && 'units' in s).toBe(false);
  });
});
