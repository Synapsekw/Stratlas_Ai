import type { ComparisonResult, SiteMaterial, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { figureOn, foldSmall, inventoryByMaterial, resultOn } from './figures';

const result = (
  to: string,
  net: number,
  extra: Partial<ComparisonResult> = {},
): ComparisonResult => ({
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
  ...extra,
});

const pile = (
  id: string,
  results: ComparisonResult[],
  series: ComparisonResult[] = [],
  material?: string,
): SurveyMeasurement => ({
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
  results,
  series,
  ...(material !== undefined ? { material } : {}),
  createdAt: '2026-10-09T00:00:00Z',
});

const DATES: Record<string, number> = { d1: 1, d2: 2, d3: 3 };
const dateOf = (c: string): number | null => DATES[c] ?? null;

describe('figureOn', () => {
  it('prefers the stored result for its own date and the series row for another date, null when absent', () => {
    const m = pile(
      'a',
      [result('d2', 200)],
      [result('d1', 100), result('d2', 999)], // the stored result stands for d2
    );
    expect(figureOn(m, 'd2')).toEqual({
      capture: 'd2',
      netM3: 200,
      cutM3: 0,
      fillM3: 200,
      status: 'ok',
    });
    expect(figureOn(m, 'd1')?.netM3).toBe(100);
    expect(figureOn(m, 'd3')).toBeNull();
    expect(figureOn(pile('b', []), 'd1')).toBeNull();
  });

  it('names the status: carried, stale, refused and partial', () => {
    const carried = { from: 'kit' as const, base: 'tin', pile: 'p', epoch: 'e1' };
    const m = pile(
      'a',
      [result('d3', 30, { carried })],
      [
        result('d1', 10, { status: 'stale' }),
        result('d2', 0, { status: 'refused', reason: 'outside' }),
      ],
    );
    expect(figureOn(m, 'd3')?.status).toBe('carried');
    expect(figureOn(m, 'd1')?.status).toBe('stale');
    expect(figureOn(m, 'd2')?.status).toBe('refused');
    expect(figureOn(pile('p', [result('d1', 5, { status: 'partial' })]), 'd1')?.status).toBe(
      'partial',
    );
    // a stale carried figure is stale first
    expect(figureOn(pile('s', [result('d1', 5, { carried, status: 'stale' })]), 'd1')?.status).toBe(
      'stale',
    );
  });

  it('gives the full result row for readouts', () => {
    const m = pile('a', [result('d2', 200)], [result('d1', 100)]);
    expect(resultOn(m, 'd1')?.totalM3).toBe(100);
    expect(resultOn(m, 'd9')).toBeNull();
  });
});

const MATERIALS: SiteMaterial[] = [
  { id: 'sand', name: 'Sand', densityTPerM3: 1.5 },
  {
    id: 'agg',
    name: 'Aggregate',
    colour: '#112233',
    densityTPerM3: 2,
    densityHistory: [
      { fromCapture: 'd1', tPerM3: 1.6 },
      { fromCapture: 'd2', tPerM3: 2 },
    ],
  },
  { id: 'clay', name: 'Clay' },
];

describe('inventoryByMaterial', () => {
  const piles = [
    pile('a1', [result('d2', 100)], [result('d1', 80)], 'agg'),
    pile('a2', [result('d2', 300)], [result('d1', 310)], 'agg'),
    pile('s1', [result('d2', 50)], [result('d1', 50)], 'sand'),
    pile('n1', [result('d2', 1000)], [], undefined),
    pile('n2', [result('d2', 5)], [], 'gone'), // a material the site no longer has
    pile('c1', [result('d2', 20)], [], 'clay'),
    pile('x', [result('d2', 70, { status: 'stale' })], [], 'sand'), // not counted
  ];

  it('groups, sorts, subtotals and puts No material last', () => {
    const groups = inventoryByMaterial(piles, 'd2', 'd1', MATERIALS, dateOf);
    expect(groups.map((g) => g.material?.id ?? null)).toEqual(['agg', 'sand', 'clay', null]);
    const [agg, sand, clay, none] = groups;
    expect(agg?.volumeM3).toBe(400);
    expect(agg?.tonnes).toBe(800);
    expect(agg?.deltaM3).toBe(10); // +20 and -10
    expect(agg?.colour).toBe('#112233');
    expect(agg?.piles.map((p) => p.id)).toEqual(['a2', 'a1']);
    expect(agg?.piles[1]).toEqual({
      id: 'a1',
      label: 'a1',
      volumeM3: 100,
      tonnes: 200,
      deltaM3: 20,
    });
    expect(sand?.volumeM3).toBe(50);
    expect(sand?.tonnes).toBe(75);
    expect(sand?.deltaM3).toBe(0);
    expect(sand?.colour).toBe('var(--mat-1)');
    // a material without a density has no tonnes
    expect(clay?.tonnes).toBeNull();
    expect(clay?.deltaM3).toBeNull();
    expect(none?.volumeM3).toBe(1005);
    expect(none?.tonnes).toBeNull();
    expect(none?.piles.map((p) => p.id)).toEqual(['n1', 'n2']);
  });

  it('uses the density on that date', () => {
    const [agg] = inventoryByMaterial(piles, 'd1', null, MATERIALS, dateOf);
    expect(agg?.volumeM3).toBe(390);
    expect(agg?.tonnes).toBeCloseTo(390 * 1.6);
    expect(agg?.deltaM3).toBeNull();
  });
});

describe('foldSmall', () => {
  const nets = [
    -4384, -3000, -2500, -2000, -1500, -1200, -900, -700, -500, -300, -200, 150, 400, 34.2, -12, 5,
    -30, 1, 0,
  ];
  const rows = nets.map((netM3, i) => ({ id: `p${String(i)}`, netM3 }));

  it('keeps 13 and reports +6 within 35', () => {
    const { shown, folded } = foldSmall(rows);
    expect(shown).toHaveLength(13);
    expect(folded).toEqual({ count: 6, withinM3: 35 });
    expect(shown.map((r) => r.netM3)).toEqual([
      -4384, -3000, -2500, -2000, -1500, -1200, -900, -700, -500, -300, -200, 150, 400,
    ]);
  });

  it('folds nothing when the rows fit', () => {
    expect(foldSmall(rows.slice(0, 3), 13)).toEqual({
      shown: [...rows.slice(0, 3)].sort((a, b) => a.netM3 - b.netM3),
      folded: null,
    });
  });
});
