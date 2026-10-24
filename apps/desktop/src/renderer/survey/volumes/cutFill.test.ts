import type { ComparisonItem, ComparisonResult, HeightTiles, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  captureRef,
  CUT_FILL_DEFAULT_M,
  cutFillByPile,
  cutFillCsv,
  cutFillTotals,
  inventoryChange,
  parseThreshold,
  readCutFillPrefs,
  shortPileLabel,
  siteCellM,
  wholeSiteCutFill,
  writeCutFillPrefs,
  type PileRun,
} from './cutFill';

const pile = (id: string, label: string, over: Partial<SurveyMeasurement> = {}) =>
  ({
    id,
    label,
    tool: 'volume',
    family: 'polygon',
    scope: { kind: 'site' },
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ],
    items: [],
    results: [],
    ...over,
  }) as unknown as SurveyMeasurement;

const result = (cut: number, fill: number, over: Partial<ComparisonResult> = {}) =>
  ({
    item: 'cutfill',
    status: 'ok',
    cutM3: cut,
    fillM3: fill,
    netM3: fill - cut,
    totalM3: fill + cut,
    ...over,
  }) as ComparisonResult;

const FROM = { kind: 'survey', surface: 's1', capture: 'c1' } as const;
const TO = { kind: 'survey', surface: 's2', capture: 'c2' } as const;

describe('cut and fill per pile', () => {
  it('per-pile cut and fill use the threshold', async () => {
    const run = vi.fn<PileRun>((_ring, item) =>
      Promise.resolve(item.deadbandM === 0.25 ? result(40, 2) : result(50, 9)),
    );
    const rows = await cutFillByPile(
      [pile('a', 'Pile 05'), pile('b', 'Pile 12')],
      { from: FROM, to: TO },
      0.25,
      run,
    );
    expect(run).toHaveBeenCalledTimes(2);
    const item = run.mock.calls[0]?.[1];
    expect(item).toMatchObject({ from: FROM, to: TO, useDeadband: true, deadbandM: 0.25 });
    expect(run.mock.calls[0]?.[0]).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(rows).toEqual([
      { id: 'a', label: 'P05', cutM3: 40, fillM3: 2, netM3: -38, status: 'ok' },
      { id: 'b', label: 'P12', cutM3: 40, fillM3: 2, netM3: -38, status: 'ok' },
    ]);
  });

  it('a zero threshold turns the deadband off', async () => {
    const run = vi.fn<PileRun>(() => Promise.resolve(result(1, 1)));
    await cutFillByPile([pile('a', 'A')], { from: FROM, to: TO }, 0, run);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ useDeadband: false });
  });

  it('a survey-scoped pile runs on its own date (its ring shift)', async () => {
    const run = vi.fn<PileRun>(() => Promise.resolve(result(1, 1)));
    await cutFillByPile(
      [pile('a', 'A', { scope: { kind: 'survey', capture: 'c2' } })],
      { from: FROM, to: TO },
      0.1,
      run,
    );
    expect(run.mock.calls[0]?.[2]).toBe('c2');
  });

  it('a pile the engine could not compute is kept with its status and no figures counted', async () => {
    const run = vi
      .fn<(r: [number, number][], i: ComparisonItem) => Promise<ComparisonResult>>()
      .mockResolvedValueOnce(result(10, 0))
      .mockRejectedValueOnce(new Error('no data'));
    const rows = await cutFillByPile(
      [pile('a', 'A'), pile('b', 'B')],
      { from: FROM, to: TO },
      0.1,
      run,
    );
    expect(rows[1]).toMatchObject({ id: 'b', status: 'refused', netM3: 0 });
    expect(cutFillTotals(rows)).toEqual({ cutM3: 10, fillM3: 0, netM3: -10, counted: 1 });
  });

  it('stops between piles when cancelled', async () => {
    const ac = new AbortController();
    const run = vi.fn(() => {
      ac.abort();
      return Promise.resolve(result(1, 0));
    });
    await expect(
      cutFillByPile([pile('a', 'A'), pile('b', 'B')], { from: FROM, to: TO }, 0.1, run, ac.signal),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('whole site', () => {
  it('whole site passes deadbandM to the engine', async () => {
    const site = vi.fn(() => Promise.resolve({ result: result(24297.1, 2098.8), grid: null }));
    const out = await wholeSiteCutFill({ from: FROM, to: TO }, 0.1, 0.5, site);
    expect(site).toHaveBeenCalledWith(
      { from: FROM, to: TO, cellM: 0.5, deadbandM: 0.1 },
      'cutfill-site',
    );
    expect(out.cutM3).toBe(24297.1);
    expect(out.netM3).toBeCloseTo(2098.8 - 24297.1, 6);
  });

  it('the cell keeps the whole site under a million cells and never finer than the surfaces', () => {
    const s = (cellM: number, w: number) =>
      ({ cellM, bounds: [0, 0, 0, w, w, 0] }) as unknown as HeightTiles;
    expect(siteCellM([s(0.2, 100)])).toBeCloseTo(0.2, 9);
    expect(siteCellM([s(0.2, 4000)])).toBeCloseTo(4, 9);
  });
});

describe('the pieces around the figures', () => {
  it('a date picks its own prepared surface', () => {
    const t = (id: string, capture: string) =>
      ({ id, capture, source: { kind: 'dsm' } }) as unknown as HeightTiles;
    expect(captureRef([t('s1', 'c1'), t('s2', 'c2')], 'c2')).toEqual({
      kind: 'survey',
      surface: 's2',
      capture: 'c2',
    });
    expect(captureRef([t('s1', 'c1')], 'c9')).toBeNull();
  });

  it('pile labels shorten "Pile 05" to "P05" and keep any other name', () => {
    expect(shortPileLabel('Pile 05')).toBe('P05');
    expect(shortPileLabel('pile 7')).toBe('P7');
    expect(shortPileLabel('North bund')).toBe('North bund');
  });

  it('the threshold reads a decimal, comma or point, and refuses the rest', () => {
    expect(parseThreshold('0.25')).toBe(0.25);
    expect(parseThreshold('0,5')).toBe(0.5);
    expect(parseThreshold('0')).toBe(0);
    expect(parseThreshold('-1')).toBeNull();
    expect(parseThreshold('abc')).toBeNull();
    expect(parseThreshold('11')).toBeNull();
  });

  it('the threshold and the area are kept per project, and a broken store falls back', () => {
    const mem = new Map<string, string>();
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    expect(readCutFillPrefs('p1', store)).toEqual({
      thresholdM: CUT_FILL_DEFAULT_M,
      area: 'piles',
    });
    writeCutFillPrefs('p1', { thresholdM: 0.3, area: 'site' }, store);
    expect(mem.has('stratlas.cutFill.p1')).toBe(true);
    expect(readCutFillPrefs('p1', store)).toEqual({ thresholdM: 0.3, area: 'site' });
    expect(readCutFillPrefs('p2', store).thresholdM).toBe(CUT_FILL_DEFAULT_M);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readCutFillPrefs('p1', broken).thresholdM).toBe(CUT_FILL_DEFAULT_M);
    expect(() => {
      writeCutFillPrefs('p1', { thresholdM: 1, area: 'piles' }, broken);
    }).not.toThrow();
    mem.set('stratlas.cutFill.p3', '{"thresholdM":-4,"area":"moon"}');
    expect(readCutFillPrefs('p3', store)).toEqual({
      thresholdM: CUT_FILL_DEFAULT_M,
      area: 'piles',
    });
  });

  it('the inventory change is the sum of the piles on To minus on From, null when one is missing', () => {
    const withSeries = (id: string, a: number, b: number) =>
      pile(id, id, {
        items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
        series: [
          { ...result(0, a, { item: 'a' }), toCapture: 'c1' },
          { ...result(0, b, { item: 'a' }), toCapture: 'c2' },
        ],
      });
    expect(inventoryChange([withSeries('a', 100, 80), withSeries('b', 10, 5)], 'c1', 'c2')).toBe(
      -25,
    );
    expect(inventoryChange([withSeries('a', 100, 80), pile('b', 'b')], 'c1', 'c2')).toBeNull();
  });

  it('the CSV has a row per pile and the totals, with plain numbers', () => {
    const csv = cutFillCsv(
      [{ id: 'a', label: 'Pile, 05', cutM3: 10.04, fillM3: 1, netM3: -9.04, status: 'ok' }],
      { pile: 'Pile', cut: 'Cut m³', fill: 'Fill m³', net: 'Net m³', total: 'Site total' },
    );
    expect(csv.split('\n')).toEqual([
      'Pile,Cut m³,Fill m³,Net m³',
      '"Pile, 05",10.04,1.00,-9.04',
      'Site total,10.04,1.00,-9.04',
    ]);
  });
});
