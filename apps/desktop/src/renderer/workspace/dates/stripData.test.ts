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

describe('stripDays', () => {
  const piles = [
    pile('p1', { c1: 100, c2: 80 }, 'agg'),
    pile('p2', { c1: 50, c2: 60 }, 'sand'),
    pile('p3', { c2: 10 }),
  ];
  const days = stripDays(CAPTURES, piles, MATERIALS, tag);

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
    const d = stripDays(CAPTURES, [pile('p1', { c2: 5 })], [], tag);
    expect(d[0]?.volumeM3).toBeNull();
    expect(stripDates(d).map((x) => x.capture)).toEqual(['c2']);
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
  const days = stripDays(CAPTURES, [pile('p1', { c1: 100, c2: 80 }, 'agg')], MATERIALS, tag);

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
    const d = stripDays(CAPTURES, [pile('p1', { c2: 80 })], [], tag);
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
