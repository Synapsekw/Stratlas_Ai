// @vitest-environment jsdom
import type { ComparisonResult, SiteMaterial, SurveyMeasurement } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  captureDateOf,
  createMaterialsDraft,
  densityImpact,
  historyRows,
  materialRows,
  swatch,
  type DatedCapture,
} from './materialsDraft';

vi.mock('../measureStore', () => ({
  measureStore: { getState: () => ({ settings: { materials: [] }, readOnly: false }) },
  saveSiteSettings: vi.fn(),
  replaceMeasurements: vi.fn(),
}));

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

const pile = (id: string, byDate: Record<string, number>, material?: string): SurveyMeasurement => {
  const rows = Object.entries(byDate).map(([c, v]) => result(c, v));
  const last = rows.at(-1);
  return {
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
    results: last ? [last] : [],
    series: rows.slice(0, -1),
    ...(material !== undefined ? { material } : {}),
    createdAt: '2026-10-09T00:00:00Z',
  };
};

const CAPTURES: DatedCapture[] = [
  { id: 'd2', date: '2021-01-10' },
  { id: 'd1', date: '2020-12-31' },
  { id: 'd3', date: '2021-02-01' },
  { id: 'nodate', date: '' },
];
const dateOf = captureDateOf(CAPTURES);

const AGG: SiteMaterial = { id: 'agg', name: 'Aggregate', densityTPerM3: 1.6 };
const SAND: SiteMaterial = { id: 'sand', name: 'Sand', densityTPerM3: 1.5, colour: '#112233' };
const MATERIALS = [AGG, SAND];
const PILES = [
  pile('p1', { d1: 100, d2: 200, d3: 300 }, 'agg'),
  pile('p2', { d1: 50, d2: 50, d3: 50 }, 'sand'),
  pile('p3', { d1: 10, d2: 10, d3: 10 }),
];

describe('captureDateOf', () => {
  it('orders dated captures and gives null for an undated one', () => {
    expect(dateOf('d1')).toBeLessThan(dateOf('d2') ?? 0);
    expect(dateOf('nodate')).toBeNull();
    expect(dateOf('unknown')).toBeNull();
  });
});

describe('materialRows', () => {
  it('shows density, piles, m³ and tonnes per material and All materials', () => {
    const { rows, total } = materialRows(MATERIALS, PILES, {}, 'd2', dateOf);
    expect(rows.map((r) => [r.material.id, r.density, r.piles, r.volumeM3, r.tonnes])).toEqual([
      ['agg', 1.6, 1, 200, 320],
      ['sand', 1.5, 1, 50, 75],
    ]);
    expect(rows[0]?.colour).toBe('var(--mat-1)');
    expect(rows[1]?.colour).toBe('#112233');
    expect(total).toEqual({ piles: 2, volumeM3: 250, tonnes: 395 });
  });

  it('counts a pending assignment', () => {
    const { rows } = materialRows(MATERIALS, PILES, { p3: 'agg', p2: null }, 'd2', dateOf);
    expect(rows.map((r) => [r.material.id, r.piles, r.volumeM3])).toEqual([
      ['agg', 2, 210],
      ['sand', 0, 0],
    ]);
  });

  it('a material with no density has no tonnes', () => {
    const { rows, total } = materialRows([{ id: 'agg', name: 'A' }], PILES, {}, 'd2', dateOf);
    expect(rows[0]?.tonnes).toBeNull();
    expect(total.tonnes).toBeNull();
  });
});

describe('the draft store', () => {
  const make = (base: SiteMaterial[] = MATERIALS) => {
    const save = vi.fn<
      (m: SiteMaterial[], a: Record<string, string | null>) => Promise<string | null>
    >(() => Promise.resolve(null));
    const store = createMaterialsDraft({
      base: () => base,
      captures: () => CAPTURES,
      readOnly: () => false,
      save,
    });
    return { store, save };
  };

  it('editing density from 10 Jan keeps 31 Dec at the earlier density', () => {
    const { store } = make();
    store.getState().setDensityFrom('agg', 'd2', 1.62);
    const draft = store.getState().draft?.find((m) => m.id === 'agg');
    expect(draft?.densityHistory).toEqual([
      { fromCapture: 'd1', tPerM3: 1.6 },
      { fromCapture: 'd2', tPerM3: 1.62 },
    ]);
    expect(draft?.densityTPerM3).toBe(1.62);
    expect(store.getState().densityEdits.agg).toEqual({ fromCapture: 'd2', tPerM3: 1.62 });
  });

  it('a new date for the same edit starts again from the saved material', () => {
    const { store } = make();
    store.getState().setDensityFrom('agg', 'd2', 1.62);
    store.getState().setDensityFrom('agg', 'd3', 1.62);
    const draft = store.getState().draft?.find((m) => m.id === 'agg');
    expect(draft?.densityHistory).toEqual([
      { fromCapture: 'd1', tPerM3: 1.6 },
      { fromCapture: 'd3', tPerM3: 1.62 },
    ]);
  });

  it('a middle-date edit of three surveys changes the second and third only (Review Focus 4)', () => {
    const { store } = make();
    store.getState().setDensityFrom('agg', 'd2', 2);
    const draft = store.getState().draft ?? [];
    const { rows: r1 } = materialRows(draft, PILES, {}, 'd1', dateOf);
    const { rows: r2 } = materialRows(draft, PILES, {}, 'd2', dateOf);
    const { rows: r3 } = materialRows(draft, PILES, {}, 'd3', dateOf);
    expect(r1[0]?.tonnes).toBe(160);
    expect(r2[0]?.tonnes).toBe(400);
    expect(r3[0]?.tonnes).toBe(600);
  });

  it('edit keeps the rest of the draft and the other materials', () => {
    const { store } = make();
    store.getState().setDensityFrom('agg', 'd2', 1.62);
    store.getState().edit('agg', { swell: { loose: 1.2, compacted: 1 } });
    const d = store.getState().draft ?? [];
    expect(d.find((m) => m.id === 'agg')?.swell).toEqual({ loose: 1.2, compacted: 1 });
    expect(d.find((m) => m.id === 'agg')?.densityTPerM3).toBe(1.62);
    expect(d.find((m) => m.id === 'sand')).toEqual(SAND);
  });

  it('Save writes densityHistory and densityTPerM3 equal to the newest entry', async () => {
    const { store, save } = make();
    store.getState().setDensityFrom('agg', 'd2', 1.62);
    store.getState().assign('agg', ['p3']);
    expect(await store.getState().save()).toBeNull();
    const [materials, assignments] = save.mock.calls[0] ?? [];
    const agg = materials?.find((m) => m.id === 'agg');
    expect(agg?.densityTPerM3).toBe(1.62);
    expect(agg?.densityHistory?.at(-1)).toEqual({ fromCapture: 'd2', tPerM3: 1.62 });
    expect(assignments).toEqual({ p3: 'agg' });
    expect(store.getState().draft).toBeNull();
  });

  it('Save refuses a material the contract rejects and keeps the draft', async () => {
    const { store, save } = make();
    store.getState().edit('agg', { name: '' });
    const err = await store.getState().save();
    expect(err).toMatch(/name/);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().draft).not.toBeNull();
  });

  it('a failed save keeps the draft and says why', async () => {
    const { store, save } = make();
    save.mockResolvedValueOnce('disk full');
    store.getState().setDensityFrom('agg', 'd2', 1.62);
    expect(await store.getState().save()).toBe('disk full');
    expect(store.getState().draft).not.toBeNull();
  });

  it('Cancel drops the draft', () => {
    const { store } = make();
    store.getState().setDensityFrom('agg', 'd2', 1.62);
    store.getState().assign('sand', ['p1']);
    store.getState().cancel();
    expect(store.getState().draft).toBeNull();
    expect(store.getState().assignments).toEqual({});
    expect(store.getState().densityEdits).toEqual({});
    expect(store.getState().dirty()).toBe(false);
  });

  it('Assign piles moves a pile from another material, unassign leaves it with none', () => {
    const { store } = make();
    store.getState().assign('sand', ['p1']);
    expect(store.getState().assignments).toEqual({ p1: 'sand' });
    expect(store.getState().dirty()).toBe(true);
    store.getState().unassign('p2');
    expect(store.getState().assignments).toEqual({ p1: 'sand', p2: null });
  });

  it('add makes a material with a fresh id', () => {
    const { store } = make();
    const id = store.getState().add('Aggregate');
    expect(id).toBe('aggregate');
    expect(store.getState().draft?.at(-1)).toEqual({ id: 'aggregate', name: 'Aggregate' });
  });

  it('importing CSV merges by id into the draft', () => {
    const { store } = make();
    const r = store
      .getState()
      .importCsv('id,name,density_t_per_m3\r\nagg,Aggregate 20,1.7\r\nclay,Clay,1.9\r\nbad\r\n');
    expect(r.read).toBe(2);
    expect(r.problems.length).toBe(1);
    const d = store.getState().draft ?? [];
    expect(d.map((m) => [m.id, m.densityTPerM3])).toEqual([
      ['agg', 1.7],
      ['sand', 1.5],
      ['clay', 1.9],
    ]);
  });
});

describe('densityImpact', () => {
  it('names the date, the tonnes before and after, and the earlier date kept', () => {
    const { store } = make2();
    store.getState().setDensityFrom('agg', 'd2', 1.62);
    const draft = store.getState().draft?.find((m) => m.id === 'agg');
    const impact = densityImpact(AGG, draft ?? AGG, 'd2', PILES, {}, CAPTURES);
    expect(impact).toEqual({ capture: 'd2', from: 320, to: 324, other: 'd1', otherTonnes: 160 });
  });

  it('is null from the earliest date (nothing kept) or without a density', () => {
    expect(densityImpact(AGG, { ...AGG, densityTPerM3: 2 }, 'd1', PILES, {}, CAPTURES)).toBeNull();
    expect(densityImpact({ id: 'agg', name: 'A' }, AGG, 'd2', PILES, {}, CAPTURES)).toBeNull();
  });
});

describe('historyRows', () => {
  it('lists entries newest first and marks the edited one new', () => {
    const m: SiteMaterial = {
      ...AGG,
      densityHistory: [
        { fromCapture: 'd1', tPerM3: 1.6 },
        { fromCapture: 'd2', tPerM3: 1.62 },
      ],
    };
    expect(historyRows(m, { fromCapture: 'd2', tPerM3: 1.62 }, dateOf)).toEqual([
      { fromCapture: 'd2', tPerM3: 1.62, isNew: true },
      { fromCapture: 'd1', tPerM3: 1.6, isNew: false },
    ]);
    expect(historyRows(AGG, null, dateOf)).toEqual([]);
  });
});

describe('swatch', () => {
  it('gives palette tokens and No material a fallback', () => {
    expect(swatch('var(--mat-3)')).toMatch(/^var\(--mat-3, oklch\(/);
    expect(swatch('var(--mat-none)')).toBe('var(--mat-none, var(--fg-4))');
    expect(swatch('#112233')).toBe('#112233');
  });
});

function make2() {
  return {
    store: createMaterialsDraft({
      base: () => MATERIALS,
      captures: () => CAPTURES,
      readOnly: () => false,
      save: () => Promise.resolve(null),
    }),
  };
}
