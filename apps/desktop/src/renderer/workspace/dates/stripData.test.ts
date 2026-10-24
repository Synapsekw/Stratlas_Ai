import type { ComparisonResult, SiteMaterial, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  changeBetween,
  consecutivePairs,
  legendOf,
  nearestDay,
  readoutOf,
  stepDay,
  stripDates,
  stripDays,
  valueOn,
  withAssignments,
} from './stripData';
import { inventorySeries } from '@aio/survey';
import { countedBy, type IsCounted } from '../../survey/volumes/inventory';
import { stackSeries } from './stripModel';

const result = (to: string, net: number): ComparisonResult => ({
  item: 'pile',
  status: 'ok',
  cutM3: 0,
  fillM3: net,
  netM3: net,
  totalM3: net,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 0,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'base',
  toLabel: to,
  toCapture: to,
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: 'sha256:x',
  computedAt: '2026-10-09T00:00:00Z',
});

const pile = (
  id: string,
  figures: Record<string, number>,
  material?: string,
): SurveyMeasurement => {
  const rows = Object.entries(figures).map(([c, v]) => result(c, v));
  return {
    id,
    family: 'polygon',
    tool: 'volume',
    label: id,
    scope: { kind: 'site' },
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ],
    items: [{ id: 'pile', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: rows.slice(-1),
    series: rows.slice(0, -1),
    ...(material !== undefined ? { material } : {}),
    createdAt: '2026-10-09T00:00:00Z',
  };
};

const MATERIALS: SiteMaterial[] = [
  { id: 'agg', name: 'Aggregate', densityTPerM3: 1.6 },
  { id: 'sand', name: 'Sand' },
];
// out of order, and one without a date (Review Focus 3)
const CAPTURES = [{ id: 'c2', date: '2021-01-10' }, { id: 'cx' }, { id: 'c1', date: '2020-12-31' }];
const tag = (c: string) => ({ long: `long ${c}`, short: `short ${c}`, colour: `var(--${c})` });
/** Every figure with a counted status (the inventory's rule with nothing stale or failed). */
const all: IsCounted = () => true;

describe('stripDays', () => {
  const piles = [
    pile('p1', { c1: 100, c2: 80 }, 'agg'),
    pile('p2', { c1: 50, c2: 60 }, 'sand'),
    pile('p3', { c2: 10 }),
  ];
  const days = stripDays(CAPTURES, piles, MATERIALS, tag, all);

  it('lists the dated surveys oldest first and skips an undated one', () => {
    expect(days.map((d) => d.capture)).toEqual(['c1', 'c2']);
    expect(days[0]?.label).toBe('long c1');
    expect(days[0]?.colour).toBe('var(--c1)');
  });

  it('totals the volume and the tonnes of the materials with a density', () => {
    expect(days[0]?.volumeM3).toBe(150);
    expect(days[0]?.tonnes).toBeCloseTo(160);
    expect(days[1]?.volumeM3).toBe(150);
    expect(days[1]?.piles.get('p3')).toEqual({ volumeM3: 10, tonnes: null });
  });

  it('stacks by material with No material on top', () => {
    const s = stackSeries(stripDates(days), 'volume');
    expect(s.layers.map((l) => l.key)).toEqual(['agg', 'sand', '']);
    expect(s.totals.map((t) => t.value)).toEqual([150, 150]);
    expect(legendOf(days).map((e) => [e.key, e.name])).toEqual([
      ['agg', 'Aggregate'],
      ['sand', 'Sand'],
      ['', null],
    ]);
  });

  it('gives a date without a counted figure no value, never zero', () => {
    const d = stripDays(CAPTURES, [pile('p1', { c2: 5 })], [], tag, all);
    expect(d[0]?.volumeM3).toBeNull();
    expect(stackSeries(stripDates(d), 'volume').totals.map((x) => x.capture)).toEqual(['c2']);
  });

  it('applies the draft assignments', () => {
    const moved = withAssignments(piles, { p3: 'agg', p1: null });
    expect(moved.find((p) => p.id === 'p3')?.material).toBe('agg');
    expect(moved.find((p) => p.id === 'p1')?.material).toBeUndefined();
    expect(piles[0]?.material).toBe('agg');
  });

  it('reads a pile or the site in each mode', () => {
    const d = days[1];
    if (!d) throw new Error('no day');
    expect(valueOn(d, 'volume', null)).toBe(150);
    expect(valueOn(d, 'tonnes', 'p1')).toBeCloseTo(128);
    expect(valueOn(d, 'cutFill', 'p2')).toBe(60);
    expect(valueOn(d, 'volume', 'nope')).toBeNull();
  });
});

describe('readoutOf', () => {
  const days = stripDays(CAPTURES, [pile('p1', { c1: 100, c2: 80 }, 'agg')], MATERIALS, tag, all);

  it('gives the figures and the change since the survey before', () => {
    const r = readoutOf(days, 'c2', 'volume', null);
    expect(r?.volumeM3).toBe(80);
    expect(r?.tonnes).toBeCloseTo(128);
    expect(r?.delta?.value).toBe(-20);
    expect(r?.delta?.pct).toBeCloseTo(-20);
    expect(r?.vs?.capture).toBe('c1');
    expect(readoutOf(days, 'c1', 'volume', null)?.delta).toBeNull();
  });

  it('waits for a survey before that is still preparing', () => {
    const d = stripDays(CAPTURES, [pile('p1', { c2: 80 })], [], tag, all);
    const r = readoutOf(d, 'c2', 'volume', null, (c) => (c === 'c1' ? 'preparing' : 'ready'));
    expect(r?.delta).toBeNull();
    expect(r?.waiting?.capture).toBe('c1');
    expect(readoutOf(d, 'c2', 'volume', null, () => 'ready')?.waiting).toBeNull();
  });

  it('works out the compare change, the pairs, snapping and stepping', () => {
    expect(changeBetween(days, 'c1', 'c2', 'volume', null)).toBe(-20);
    expect(changeBetween(days, 'c1', 'nope', 'volume', null)).toBeNull();
    expect(consecutivePairs(days)).toEqual([{ from: 'c1', to: 'c2' }]);
    expect(nearestDay(days, Date.parse('2021-01-08'))?.capture).toBe('c2');
    expect(stepDay(days, 'c2', 1)?.capture).toBe('c2');
    expect(stepDay(days, 'c2', -1)?.capture).toBe('c1');
    expect(stepDay(days, null, 1)?.capture).toBe('c1');
  });
});

describe('one counting rule with the Volumes tab', () => {
  const DATED = [
    { id: 'c1', date: '2020-12-31', label: '31 Dec' },
    { id: 'c2', date: '2021-01-10', label: '10 Jan' },
    { id: 'c3', date: '2021-02-01', label: '1 Feb' },
  ];
  const piles = [pile('p1', { c1: 100, c2: 80, c3: 70 }), pile('p2', { c1: 40, c3: 50 })];
  // the inventory leaves p2 out on c1 (stale by the fingerprints, say)
  const rows = inventorySeries(piles, DATED, {
    isStale: (m, r) => m.id === 'p2' && r.toCapture === 'c1',
  });
  const days = stripDays(DATED, piles, [], tag, countedBy(rows));

  it('adds only the figures the inventory counts, so the totals match its rows', () => {
    expect(days.map((d) => d.volumeM3)).toEqual(rows.map((r) => r.totalM3));
    expect(days[0]?.piles.has('p2')).toBe(false);
  });

  it('measures the change as the header does: over the piles counted on both dates', () => {
    const r = readoutOf(days, 'c3', 'volume', null);
    expect(r?.vs?.capture).toBe('c2');
    // only p1 is on both c2 and c3: 70 - 80, never the totals' 120 - 80
    expect(r?.delta?.value).toBe(-10);
    expect(r?.delta?.value).toBe(rows[2]?.change?.m3);
    expect(r?.delta?.pct).toBeCloseTo(-12.5);
    expect(changeBetween(days, 'c1', 'c3', 'volume', null)).toBe(-30);
  });

  it('skips back to the nearest earlier date with counted piles', () => {
    const one = [pile('p1', { c1: 100, c3: 70 })];
    const gap = stripDays(DATED, one, [], tag, countedBy(inventorySeries(one, DATED)));
    expect(gap[1]?.volumeM3).toBeNull();
    const r = readoutOf(gap, 'c3', 'volume', null, () => 'ready');
    expect(r?.vs?.capture).toBe('c1');
    expect(r?.delta?.value).toBe(-30);
  });
});

describe('two surveys on the same day', () => {
  const SAME = [
    { id: 'b', date: '2021-01-10' },
    { id: 'a', date: '2021-01-10' },
    { id: 'z', date: '2021-01-01' },
  ];
  const days = stripDays(SAME, [pile('p1', { z: 1, a: 2, b: 3 })], [], tag, all);

  it('keeps each survey with its own time, in a stable order', () => {
    expect(days.map((d) => d.capture)).toEqual(['z', 'a', 'b']);
    const [, a, b] = days;
    expect(a && b && b.t > a.t).toBe(true);
    expect(b && b.t - Date.parse('2021-01-10') < 86_400_000).toBe(true);
    expect(nearestDay(days, b?.t ?? 0)?.capture).toBe('b');
    expect(stepDay(days, 'a', 1)?.capture).toBe('b');
    expect(readoutOf(days, 'b', 'volume', null)?.vs?.capture).toBe('a');
  });
});
