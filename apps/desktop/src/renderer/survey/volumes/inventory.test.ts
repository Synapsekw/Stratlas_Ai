import type { ComparisonResult, SiteMaterial, SurveyMeasurement } from '@aio/schema';
import type { StackRow } from '@aio/survey';
import { describe, expect, it } from 'vitest';
import { inventoryModel } from './inventory';

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

/** A site pile with a figure per date (`d1`, `d2`). */
const pile = (id: string, by: Record<string, number>, material?: string): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: id.toUpperCase(),
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [{ id: 'pile', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
  results: [],
  series: Object.entries(by).map(([c, v]) => result(c, v)),
  ...(material !== undefined ? { material } : {}),
  createdAt: '2026-10-09T00:00:00Z',
});

/** The inventory row of a date: the piles it counts. */
const row = (capture: string, parts: Record<string, number>, extra: Partial<StackRow> = {}) => ({
  capture,
  date: capture === 'd1' ? '2020-12-31' : '2021-01-10',
  label: capture === 'd1' ? '31 Dec 2020' : '10 Jan 2021',
  totalM3: Object.values(parts).reduce((a, b) => a + b, 0),
  parts: Object.entries(parts).map(([id, valueM3]) => ({ id, valueM3 })),
  missing: [],
  ...extra,
});

const MATERIALS: SiteMaterial[] = [
  { id: 'agg', name: 'Aggregate', densityTPerM3: 1.6 },
  { id: 'sand', name: 'Sand', densityTPerM3: 1.5 },
];
const DATES: Record<string, number> = { d1: 1, d2: 2 };
const dateOf = (c: string): number | null => DATES[c] ?? null;

describe('inventoryModel', () => {
  const piles = [
    pile('a', { d1: 120, d2: 100 }, 'agg'),
    pile('b', { d1: 40, d2: 50 }, 'agg'),
    pile('c', { d1: 30, d2: 20 }, 'sand'),
    pile('d', { d2: 10 }),
  ];
  const rows = [row('d1', { a: 120, b: 40, c: 30 }), row('d2', { a: 100, b: 50, c: 20, d: 10 })];

  it('gives the date in focus its volume, tonnes and change over the piles on both dates', () => {
    const m = inventoryModel(piles, rows, 'd2', MATERIALS, dateOf);
    expect(m?.on.capture).toBe('d2');
    expect(m?.previous?.capture).toBe('d1');
    expect(m?.volumeM3).toBe(180);
    expect(m?.piles).toBe(4);
    // d has no material: no tonnes, so the site tonnes are not complete
    expect(m?.tonnes).toBeCloseTo(100 * 1.6 + 50 * 1.6 + 20 * 1.5);
    expect(m?.tonnesComplete).toBe(false);
    // a, b and c are on both dates: 170 then, 190 before
    expect(m?.change?.m3).toBe(-20);
    expect(m?.change?.pct).toBeCloseTo((-20 / 190) * 100);
  });

  it('groups by material, largest first, with No material last and the density on the date', () => {
    const m = inventoryModel(piles, rows, 'd2', MATERIALS, dateOf);
    expect(m?.groups.map((g) => g.material?.id ?? null)).toEqual(['agg', 'sand', null]);
    const agg = m?.groups[0];
    expect(agg?.volumeM3).toBe(150);
    expect(agg?.deltaM3).toBe(-10);
    expect(agg?.densityTPerM3).toBe(1.6);
    expect(agg?.piles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(m?.groups[2]?.tonnes).toBeNull();
    expect(m?.groups[2]?.piles[0]?.deltaM3).toBeNull();
  });

  it('the date in focus falls back to the latest; the first date has no change', () => {
    expect(inventoryModel(piles, rows, null, MATERIALS, dateOf)?.on.capture).toBe('d2');
    expect(inventoryModel(piles, rows, 'gone', MATERIALS, dateOf)?.on.capture).toBe('d2');
    const first = inventoryModel(piles, rows, 'd1', MATERIALS, dateOf);
    expect(first?.previous).toBeNull();
    expect(first?.change).toBeNull();
    expect(first?.groups.flatMap((g) => g.piles).every((p) => p.deltaM3 === null)).toBe(true);
  });

  it('a pile the inventory leaves out (stale) is in no figure, and is named with why', () => {
    const stale = [
      row('d1', { a: 120, b: 40, c: 30 }),
      row('d2', { a: 100, c: 20, d: 10 }, { notCounted: [{ id: 'b', reason: 'stale' }] }),
    ];
    const m = inventoryModel(piles, stale, 'd2', MATERIALS, dateOf);
    expect(m?.volumeM3).toBe(130);
    expect(m?.groups.flatMap((g) => g.piles).map((p) => p.id)).not.toContain('b');
    expect(m?.notCounted).toEqual([{ id: 'b', reason: 'stale' }]);
    // the change leaves b out on both sides
    expect(m?.change?.m3).toBe(-30);
  });

  it('the change is against the nearest earlier date with counted piles', () => {
    const gap = [row('d0', {}), row('d1', { a: 120 }), row('d2', { a: 100 })];
    const m = inventoryModel(
      [pile('a', { d1: 120, d2: 100 }, 'agg')],
      gap,
      'd2',
      MATERIALS,
      dateOf,
    );
    expect(m?.previous?.capture).toBe('d1');
    const none = inventoryModel(
      [pile('a', { d2: 100 }, 'agg')],
      [row('d1', {}), row('d2', { a: 100 })],
      'd2',
      MATERIALS,
      dateOf,
    );
    expect(none?.previous).toBeNull();
  });

  it('no survey date: no figures', () => {
    expect(inventoryModel(piles, [], null, MATERIALS, dateOf)).toBeNull();
  });
});

describe('inventoryModel with the stockpile kit density (a converted kit project)', () => {
  /** A pile converted from the stockpile kit: no site material, the kit's density instead. */
  const kitPile = (id: string, by: Record<string, number>, material?: string) => ({
    ...pile(id, by, material),
    origin: { kind: 'kit-pile' as const, pile: id },
  });
  const KIT = { densityTPerM3: 1.6, names: {} };

  it('weighs kit piles with no site material by the site-wide density', () => {
    const piles = [kitPile('k1', { d1: 90, d2: 100 }), kitPile('k2', { d1: 40, d2: 50 })];
    const rows = [row('d1', { k1: 90, k2: 40 }), row('d2', { k1: 100, k2: 50 })];
    const m = inventoryModel(piles, rows, 'd2', [], dateOf, KIT);
    expect(m?.tonnes).toBeCloseTo(150 * 1.6, 9);
    expect(m?.tonnesComplete).toBe(true);
    expect(m?.groups).toHaveLength(1);
    expect(m?.groups[0]?.material?.name).toBe('Stockpile material');
    expect(m?.groups[0]?.densityTPerM3).toBe(1.6);
    expect(m?.groups[0]?.tonnes).toBeCloseTo(240, 9);
    expect(m?.groups[0]?.piles.map((p) => p.tonnes)).toEqual([160, 80]);
  });

  it('a site material the person picked wins over the kit density; other piles have none', () => {
    const piles = [kitPile('k1', { d2: 100 }, 'sand'), pile('s', { d2: 10 })];
    const m = inventoryModel(piles, [row('d2', { k1: 100, s: 10 })], 'd2', MATERIALS, dateOf, KIT);
    expect(m?.groups.map((g) => g.material?.id ?? null)).toEqual(['sand', null]);
    expect(m?.tonnes).toBeCloseTo(150, 9);
    expect(m?.tonnesComplete).toBe(false);
  });

  it('kit piles of different kit materials stay in their own groups', () => {
    const piles = [kitPile('k1', { d2: 100 }), kitPile('k2', { d2: 50 })];
    const kit = { densityTPerM3: 1.6, names: { k1: 'Gravel', k2: 'Sand fill' } };
    const m = inventoryModel(piles, [row('d2', { k1: 100, k2: 50 })], 'd2', [], dateOf, kit);
    expect(m?.groups.map((g) => g.material?.name)).toEqual(['Gravel', 'Sand fill']);
    expect(m?.groups.map((g) => g.tonnes)).toEqual([160, 80]);
  });
});
