import type { ComparisonResult, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { bulkTotals, inventorySeries, setSideForAll, setUnitsForAll } from './bulk';

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

describe('site inventory over time', () => {
  const captures = [
    { id: 'c1', date: '2026-01-10', label: '10 Jan' },
    { id: 'c2', date: '2026-02-10', label: '10 Feb' },
    { id: 'c3', date: '2026-03-10', label: '10 Mar' },
  ];
  const at = (
    capture: string,
    net: number,
    status: ComparisonResult['status'] = 'ok',
  ): ComparisonResult => ({
    ...result('pile', 0, net, status),
    toCapture: capture,
  });
  const volume = (
    id: string,
    series: ComparisonResult[],
    results: ComparisonResult[] = [],
    folder?: string,
  ): SurveyMeasurement => {
    const m: SurveyMeasurement = pile(id, results);
    delete m.template;
    return {
      ...m,
      items: [{ id: 'pile', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
      series,
      ...(folder !== undefined ? { folder } : {}),
    };
  };

  it('inventory totals count missing piles per date', () => {
    const a = volume('a', [at('c1', 100), at('c2', 120), at('c3', 130)]);
    // refused on c2 and never computed on c3: missing there, never added as zero
    const b = volume('b', [at('c1', 50), at('c2', 0, 'refused')]);
    const rows = inventorySeries([a, b], captures);
    expect(rows.map((r) => r.capture)).toEqual(['c1', 'c2', 'c3']);
    expect(rows[0]).toMatchObject({ totalM3: 150, missing: [] });
    expect(rows[1]).toMatchObject({ totalM3: 120, missing: ['b'] });
    expect(rows[2]).toMatchObject({ totalM3: 130, missing: ['b'] });
    expect(rows[0]?.parts).toEqual([
      { id: 'a', valueM3: 100 },
      { id: 'b', valueM3: 50 },
    ]);
  });

  it('inventory sums engine results, never kit figures, unless carried', () => {
    // the stored result stands for its own date over the series row of that date
    const a = volume('a', [at('c1', 100), at('c3', 999)], [at('c3', 140)]);
    // a pile carried over from the kit: its carried figures are its one figure per date
    const carried = { pile: 'p1', base: 'tin' } as NonNullable<ComparisonResult['carried']>;
    const k = volume('k', [
      { ...at('c1', 10), carried },
      { ...at('c2', 20), carried },
    ]);
    // an area or a line is never part of the inventory
    const area: SurveyMeasurement = { ...volume('x', [at('c1', 1000)]), tool: 'area' };
    const rows = inventorySeries([a, k, area], captures);
    expect(rows.map((r) => r.totalM3)).toEqual([110, 20, 140]);
    // k is absent on the last date (R16): missing there, not zero
    expect(rows[2]?.missing).toEqual(['k']);
    expect(rows[1]?.missing).toEqual(['a']);
  });

  it('folder filter narrows the stack', () => {
    const a = volume('a', [at('c1', 100)], [], 'North');
    const b = volume('b', [at('c1', 50)], [], ' North ');
    const c = volume('c', [at('c1', 7)], [], 'South');
    const d = volume('d', [at('c1', 3)]);
    expect(inventorySeries([a, b, c, d], captures)[0]?.totalM3).toBe(160);
    const north = inventorySeries([a, b, c, d], captures, { folder: 'North' });
    expect(north[0]?.totalM3).toBe(150);
    expect(north[0]?.parts.map((p) => p.id)).toEqual(['a', 'b']);
    expect(inventorySeries([a, b, c, d], captures, { folder: 'South' })[0]?.totalM3).toBe(7);
    expect(inventorySeries([a, b, c, d], captures, { folder: 'Empty' })).toEqual([]);
  });
});
