import type { ComparisonResult, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { bulkTotals, inventorySeries, pileSeries, setSideForAll, setUnitsForAll } from './bulk';

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
    expect(rows[1]?.notCounted).toEqual([{ id: 'b', reason: 'no-data' }]);
    // not worked out yet is not "no survey data", and still not added
    expect(rows[2]).toMatchObject({ totalM3: 130, missing: [] });
    expect(rows[2]?.notCounted).toEqual([{ id: 'b', reason: 'not-computed' }]);
    expect(rows[0]?.parts).toEqual([
      { id: 'a', valueM3: 100 },
      { id: 'b', valueM3: 50 },
    ]);
  });

  it('a stale figure is named, never added, stored or per date', () => {
    // a's stored figure (c2) is stale by its fingerprint; b's c2 row is stale by the series check
    const a = volume('a', [at('c1', 100)], [at('c2', 120)]);
    const b = volume('b', [at('c1', 50), { ...at('c2', 60), fingerprint: 'sha256:old' }]);
    const rows = inventorySeries([a, b], captures, {
      isStale: (m, r, stored) =>
        stored ? m.id === 'a' : r.fingerprint === 'sha256:old' && r.toCapture === 'c2',
    });
    expect(rows[1]).toMatchObject({ totalM3: 0, parts: [], missing: [] });
    expect(rows[1]?.notCounted).toEqual([
      { id: 'a', reason: 'stale' },
      { id: 'b', reason: 'stale' },
    ]);
    // a figure marked stale is stale without a predicate too
    const c = volume('c', [at('c1', 5, 'stale')]);
    expect(inventorySeries([c], captures)[0]?.notCounted).toEqual([{ id: 'c', reason: 'stale' }]);
  });

  it('the latest date counts only figures for that date (no older stored figure)', () => {
    // a's stored figure is for c2; the latest survey is c3, where it has none yet
    const a = volume('a', [at('c1', 100)], [at('c2', 120)]);
    const b = volume('b', [at('c3', 40)]);
    const latest = inventorySeries([a, b], captures).at(-1);
    expect(latest).toMatchObject({ capture: 'c3', totalM3: 40 });
    expect(latest?.notCounted).toEqual([{ id: 'a', reason: 'not-computed' }]);
  });

  it('a date worked out with no figure has no survey data, not "not computed yet"', () => {
    const a = volume('a', [at('c1', 100)]);
    const ran = (_m: SurveyMeasurement, c: string) => c !== 'c3';
    const rows = inventorySeries([a], captures, { ran });
    expect(rows[1]?.notCounted).toEqual([{ id: 'a', reason: 'no-data' }]);
    expect(rows[1]?.missing).toEqual(['a']);
    expect(rows[2]?.notCounted).toEqual([{ id: 'a', reason: 'not-computed' }]);
    // a failed last run says so, ran before or not
    const failed = inventorySeries([a], captures, { ran, failed: () => 'stopped' });
    expect(failed[1]?.notCounted).toEqual([{ id: 'a', reason: 'failed', detail: 'stopped' }]);
  });

  it('names failed runs, piles without a comparison and partial figures', () => {
    const a = volume('a', [at('c1', 100, 'partial')]);
    const f = volume('f', []);
    const none: SurveyMeasurement = { ...volume('n', []), items: [] };
    const rows = inventorySeries([a, f, none], captures, {
      failed: (m) => (m.id === 'f' ? 'the engine stopped' : null),
    });
    expect(rows[0]).toMatchObject({ totalM3: 100, partial: ['a'] });
    expect(rows[0]?.notCounted).toEqual([
      { id: 'f', reason: 'failed', detail: 'the engine stopped' },
      { id: 'n', reason: 'no-comparison' },
    ]);
    expect(rows[2]?.notCounted?.map((x) => x.reason)).toEqual([
      'not-computed',
      'failed',
      'no-comparison',
    ]);
  });

  it('the change counts only the piles on both dates, never a missing one as zero', () => {
    const a = volume('a', [at('c1', 100), at('c2', 110), at('c3', 130)]);
    const b = volume('b', [at('c1', 50), at('c3', 70)]);
    const c = volume('c', [at('c2', 9), at('c3', 10)]);
    const rows = inventorySeries([a, b, c], captures);
    expect(rows[0]?.change).toBeNull();
    // c1 → c2: only a is on both (b gone, c new): +10 over 1 of 3 piles
    expect(rows[1]?.change).toEqual({ m3: 10, piles: 1, of: 3 });
    // c2 → c3: a and c on both (b back): +20 + 1 over 2 of 3
    expect(rows[2]?.change).toEqual({ m3: 21, piles: 2, of: 3 });
    const d = volume('d', [at('c2', 1)]);
    const e = volume('e', [at('c1', 1)]);
    expect(inventorySeries([d, e], captures)[1]?.change).toBeNull();
    // cut and fill of the counted piles
    expect(rows[2]).toMatchObject({ cutM3: 0, fillM3: 210 });
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
    expect(rows[1]?.missing).toEqual([]);
    expect(rows[1]?.notCounted).toEqual([{ id: 'a', reason: 'not-computed' }]);
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

describe('pileSeries: one figure per date', () => {
  const dated = (capture: string, net: number, over: Partial<ComparisonResult> = {}) => ({
    ...result('pile', 0, net, 'ok'),
    toCapture: capture,
    ...over,
  });
  it('an item fixed to two surveys has no volume over time: rows left from a current side go', () => {
    const m: SurveyMeasurement = {
      ...pile('p', [dated('c2', -20)]),
      items: [
        {
          id: 'pile',
          from: { kind: 'survey', surface: 'dsm-1', capture: 'c1' },
          to: { kind: 'survey', surface: 'dsm-2', capture: 'c2' },
          useDeadband: false,
        },
      ],
      series: [dated('c1', 0, { status: 'stale' }), dated('c3', 5, { status: 'stale' })],
    };
    const { series, stored } = pileSeries(m);
    expect(series.map((r) => r.toCapture)).toEqual(['c2']);
    expect(stored?.netM3).toBe(-20);
  });

  it('keeps a figure carried from the kit, whatever the item', () => {
    const m: SurveyMeasurement = {
      ...pile('p', []),
      items: [
        {
          id: 'pile',
          from: { kind: 'survey', surface: 'dsm-1', capture: 'c1' },
          to: { kind: 'survey', surface: 'dsm-2', capture: 'c2' },
          useDeadband: false,
        },
      ],
      series: [dated('c1', 7, { carried: { base: 'tin' } as never })],
    };
    expect(pileSeries(m).series.map((r) => r.netM3)).toEqual([7]);
  });
});
