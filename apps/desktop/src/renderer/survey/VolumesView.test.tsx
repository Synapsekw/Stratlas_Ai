// @vitest-environment jsdom
import { formatQuantity } from '@aio/geo';
import {
  defaultSurveySettings,
  type ComparisonResult,
  type SurveyMeasurement,
  type SurveySettings,
} from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const s = vi.hoisted(() => ({
  compare: Object.create(null) as Record<string, unknown>,
  measure: {} as {
    settings: SurveySettings;
    readOnly: boolean;
    selected: string[];
    focus: string | null;
    templates: { project: never[] };
    file: { measurements: SurveyMeasurement[] };
  },
}));
const calls = vi.hoisted(() => ({
  computeSeries: vi.fn(() => Promise.resolve(false)),
  computeAll: vi.fn(() => Promise.resolve()),
  select: vi.fn(),
  startTool: vi.fn(),
  openDialog: vi.fn(),
  saveFile: vi.fn<
    (channel: string, req: { defaultName: string; data: string }) => Promise<unknown>
  >(() => Promise.resolve({ ok: true, value: { path: 'x.csv' } })),
}));

vi.mock('./compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel(s.compare),
  isStale: () => false,
  seriesStale: () => false,
  computeSeries: calls.computeSeries,
  computeAll: calls.computeAll,
}));
vi.mock('./measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  measureFolders: (file: { measurements: SurveyMeasurement[] }) =>
    [...new Set(file.measurements.flatMap((m) => (m.folder ? [m.folder] : [])))].sort(),
  knownTemplates: () => [],
  replaceMeasurement: vi.fn(),
  renameMeasurement: vi.fn(),
  select: calls.select,
  startTool: calls.startTool,
}));
vi.mock('./card/VolumeDetail', () => ({
  VolumeDetail: ({ m }: { m: SurveyMeasurement }) => (
    <div data-testid="volume-detail" data-id={m.id} />
  ),
}));
vi.mock('./card/CardActions', () => ({
  CardActions: () => null,
  CardMenu: () => null,
  NOTES_MAX: 4000,
}));
vi.mock('../shell', () => ({
  bridge: { call: calls.saveFile },
  useShell: (sel: (x: unknown) => unknown) => sel({ pkg: null }),
}));
vi.mock('../processing/store', () => ({
  processing: { getState: () => ({ openDialog: calls.openDialog }) },
}));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => false }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { root: 'C:/p', manifest: { captures: [], layers: [] } } }),
}));

const { VolumesView } = await import('./VolumesView');

const NOW = '2026-10-05T00:00:00.000Z';
const CAPTURES = [
  { id: 'c1', date: '2026-01-10', label: '10 Jan' },
  { id: 'c2', date: '2026-02-10', label: '10 Feb' },
];

function result(net: number, capture: string, over: Partial<ComparisonResult> = {}) {
  return {
    item: 'a',
    status: 'ok',
    cutM3: 0,
    fillM3: net,
    netM3: net,
    totalM3: net,
    areaM2: 100,
    areaCutM2: 0,
    areaFillM2: 100,
    areaUnchangedM2: 0,
    uncoveredM2: 0,
    fromLabel: 'Triangulated toe',
    toLabel: capture,
    toCapture: capture,
    deadbandM: 0,
    usedDeadband: false,
    cellM: 0.5,
    engine: 'ts',
    fingerprint: `sha256:${capture}`,
    computedAt: NOW,
    ...over,
  } satisfies ComparisonResult;
}

function pile(
  id: string,
  over: Partial<SurveyMeasurement> & { results?: ComparisonResult[] } = {},
): SurveyMeasurement {
  return {
    id,
    family: 'polygon',
    tool: 'volume',
    label: `Pile ${id}`,
    scope: { kind: 'site' },
    points: [
      [0, 0, 10],
      [10, 0, 10],
      [10, 10, 10],
    ],
    items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: [],
    createdAt: NOW,
    ...over,
  };
}

let host: HTMLDivElement;
let root: Root | undefined;
const render = () => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<VolumesView />);
  });
};
const q = (sel: string) => host.querySelector(sel);
const qa = (sel: string) => [...host.querySelectorAll(sel)];
const button = (name: string) =>
  qa('button').find((b) => b.textContent.trim() === name) as HTMLButtonElement | undefined;
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const settings = defaultSurveySettings();
const v = (x: number) => formatQuantity(x, 'volume', settings.units, settings.precision);

beforeEach(() => {
  vi.clearAllMocks();
  s.compare = {
    status: 'ready',
    captures: CAPTURES,
    current: {},
    surfaces: [],
    designs: [],
  };
  s.measure = {
    settings,
    readOnly: false,
    selected: [],
    focus: null,
    templates: { project: [] },
    file: { measurements: [] },
  };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('VolumesView', () => {
  it('empty state when no volumes', () => {
    s.measure.file.measurements = [{ ...pile('x'), tool: 'area' }];
    render();
    const empty = q('.empty-state');
    expect(empty?.textContent).toContain('No stockpiles yet');
    expect(q('[data-testid="volumes-inventory"]')).toBeNull();
    click(button('Draw volume'));
    expect(calls.startTool).toHaveBeenCalledWith('volume');
    click(button('Detect piles'));
    expect(calls.openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline: 'volumetric.build', project: 'C:/p' }),
    );
  });

  it('totals match the sum of the cards', () => {
    s.measure.file.measurements = [
      pile('a', { results: [result(120, 'c2')] }),
      pile('b', { results: [result(30.5, 'c2')] }),
    ];
    render();
    const rows = qa('[data-testid="volumes-pile"]');
    expect(rows).toHaveLength(2);
    // every row is the live card
    expect(rows.every((r) => r.querySelector('.mc[data-variant="live"]'))).toBe(true);
    const primaries = rows.map((r) => r.querySelector('[data-testid="card-primary"]')?.textContent);
    expect(primaries[0]).toContain(v(120).split(' ')[0]);
    expect(primaries[1]).toContain(v(30.5).split(' ')[0]);
    expect(q('[data-testid="survey-bulk-net"]')?.textContent).toBe(v(150.5));
    // the inventory's latest total is the same sum
    const latest = q('[data-testid="volumes-inventory-table"] tr[data-latest] td');
    expect(latest?.textContent).toBe(v(150.5));
  });

  it('folder filter narrows the stack', () => {
    s.measure.file.measurements = [
      pile('a', { folder: 'North', results: [result(100, 'c1')] }),
      pile('b', { folder: 'South', results: [result(7, 'c1')] }),
    ];
    render();
    const filter = q('[data-testid="volumes-folder"]') as HTMLSelectElement;
    expect([...filter.options].map((o) => o.textContent)).toEqual(['All piles', 'North', 'South']);
    expect(q('[data-testid="volumes-inventory-table"] tbody td')?.textContent).toBe(v(107));
    act(() => {
      filter.value = 'South';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(qa('[data-testid="volumes-pile"]')).toHaveLength(1);
    expect(q('[data-testid="volumes-inventory-table"] tbody td')?.textContent).toBe(v(7));
    expect(q('[data-testid="survey-bulk-net"]')?.textContent).toBe(v(7));
    expect(qa('[data-part]').map((e) => e.getAttribute('data-part'))).toEqual(['b']);
  });

  it('inventory totals count missing piles per date', () => {
    s.measure.file.measurements = [
      pile('a', { series: [result(100, 'c1')], results: [result(110, 'c2')] }),
      // carried from the kit, absent on the latest date: missing there, not zero
      pile('k', {
        series: [result(40, 'c1', { carried: { pile: 'p1', base: 'tin' } as never })],
        results: [],
      }),
    ];
    render();
    const cells = qa('[data-testid="volumes-inventory-table"] tbody tr').map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(cells[0]?.[0]).toBe(v(140));
    expect(cells[1]?.[0]).toBe(v(110));
    expect(cells[1]?.[2]).toContain('Pile k');
    expect(q('[data-testid="time-missing"]')?.textContent).toContain('1 pile has no survey data');
    // the dates are worked out for the piles shown
    expect(calls.computeSeries).toHaveBeenCalledWith('a');
  });

  it('clicking a pile focuses it in the detail card', () => {
    s.measure.file.measurements = [pile('a'), pile('b')];
    render();
    expect(q('[data-testid="volume-detail"]')).toBeNull();
    click(qa('[data-testid="volumes-pile"]')[1]);
    expect(calls.select).toHaveBeenCalledWith(['b'], 'b');
    s.measure.focus = 'b';
    s.measure.selected = ['b'];
    render();
    expect(q('[data-testid="volume-detail"]')?.getAttribute('data-id')).toBe('b');
    expect(q('.mc[data-variant="detail"]')?.getAttribute('data-measure-id')).toBe('b');
    expect(qa('[data-testid="volumes-pile"]')[1]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('exports the volume over time as CSV with the material density', async () => {
    s.measure.settings = {
      ...settings,
      materials: [{ id: 'm1', name: 'Gravel', densityTPerM3: 2 }] as never,
    };
    s.measure.file.measurements = [pile('a', { material: 'm1', results: [result(10, 'c2')] })];
    render();
    await act(async () => {
      button('CSV')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(calls.saveFile).toHaveBeenCalledTimes(1);
    const req = calls.saveFile.mock.calls[0]?.[1];
    const lines = req?.data.split(/\r?\n/) ?? [];
    expect(lines[0]).toContain('Tonnage');
    // the stored result stands for its date; tonnes = 10 m3 x 2 t/m3
    expect(lines.find((l) => l.includes('2026-02-10'))).toMatch(/,20(\.0+)?,/);
  });
});
