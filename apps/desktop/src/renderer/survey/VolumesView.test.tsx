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
    status: 'idle' | 'loading' | 'ready' | 'error';
    settings: SurveySettings;
    readOnly: boolean;
    selected: string[];
    focus: string | null;
    templates: { project: never[] };
    file: { measurements: SurveyMeasurement[] };
  },
}));
const calls = vi.hoisted(() => ({
  computeSeries: vi.fn<(id: string) => Promise<boolean>>(() => Promise.resolve(false)),
  computeAll: vi.fn(() => Promise.resolve()),
  select: vi.fn(),
  terrain: vi.fn(),
  startTool: vi.fn(),
  openDialog: vi.fn(),
  saveFile: vi.fn<
    (channel: string, req: { defaultName: string; data: string }) => Promise<unknown>
  >(() => Promise.resolve({ ok: true, value: { path: 'x.csv' } })),
}));

// which figures the fingerprint checks call stale: stored ones and per-date ones, by pile id
const stale = vi.hoisted(() => ({ stored: new Set<string>(), series: new Set<string>() }));
const job = vi.hoisted(() => ({ exists: true }));
vi.mock('./compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel(s.compare),
  isStale: (_s: unknown, m: { id: string }) => stale.stored.has(m.id),
  seriesStale: (m: { id: string }) => stale.series.has(m.id),
  computeSeries: calls.computeSeries,
  computeAll: calls.computeAll,
  recomputeCarried: vi.fn(() => Promise.resolve([])),
  hasCarried: (m: SurveyMeasurement) => m.results.some((r) => r.carried !== undefined),
  keepsCarried: (m: SurveyMeasurement) => m.results.some((r) => r.carried !== undefined),
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
// the panel's own slots: the detail card is the same card as the measurement panel's
vi.mock('./card/slots', () => ({
  // the panel's terrain read: the detail card asks it for the points where the pile is drawn
  useCardTerrain: (m: SurveyMeasurement) => {
    calls.terrain(m.id);
    return {};
  },
  slotsFor: (m: SurveyMeasurement, variant: string) =>
    variant === 'detail'
      ? {
          chips: <div data-testid="slot-chips" data-id={m.id} />,
          detail: <div data-testid="slot-detail" data-id={m.id} />,
        }
      : {},
}));
// the focused pile opens in the pile panel (its own tests), in place of the list
vi.mock('./pile/PilePanel', () => ({
  PilePanel: ({ id, order }: { id: string; order?: readonly string[] }) => (
    <div data-testid="pile-panel" data-id={id} data-order={(order ?? []).join(',')} />
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
    sel({ project: { id: 'p1', root: 'C:/p', manifest: { captures: [], layers: [] } } }),
  assetUrl: (id: string, ref: { path: string }) => `aio://project/${id}/${ref.path}`,
}));
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ ok: job.exists })),
);

const { VolumesView } = await import('./VolumesView');
const { takeVolumesPick } = await import('./volumesPick');

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

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const tableCells = () =>
  qa('[data-testid="volumes-inventory-table"] tbody tr').map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent),
  );

beforeEach(() => {
  vi.clearAllMocks();
  stale.stored.clear();
  stale.series.clear();
  job.exists = true;
  calls.computeSeries.mockImplementation(() => Promise.resolve(false));
  s.compare = {
    status: 'ready',
    captures: CAPTURES,
    current: {},
    seriesCurrent: {},
    seriesInputs: {},
    surfaces: [],
    designs: [],
  };
  s.measure = {
    status: 'ready',
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
  it('empty state when no volumes', async () => {
    s.measure.file.measurements = [{ ...pile('x'), tool: 'area' }];
    render();
    await flush();
    const empty = q('.empty-state');
    expect(empty?.textContent).toContain('No stockpiles yet');
    expect(empty?.textContent).toContain('stockpile pipeline');
    expect(q('[data-testid="volumes-inventory"]')).toBeNull();
    click(button('Draw volume'));
    expect(calls.startTool).toHaveBeenCalledWith('volume');
    click(button('Detect piles'));
    expect(calls.openDialog).toHaveBeenCalledWith({
      pipeline: 'volumetric.build',
      project: 'C:/p',
      values: { job: 'volumetric/job.json' },
    });
  });

  it('looks for the job file only once the measurements are read (no 404 while loading)', async () => {
    s.measure.status = 'loading';
    render();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    // read, with piles: nothing to look for either
    s.measure.status = 'ready';
    s.measure.file = { measurements: [pile('a')] };
    render();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Detect piles is greyed with why when the job file is missing', async () => {
    job.exists = false;
    render();
    await flush();
    const detect = q('[data-testid="volumes-detect"]');
    expect(detect?.getAttribute('aria-disabled')).toBe('true');
    click(detect);
    expect(calls.openDialog).not.toHaveBeenCalled();
  });

  it('a volume without a comparison is a pile, named as not counted', () => {
    s.measure.file.measurements = [
      pile('n', { items: [] }),
      pile('a', { results: [result(5, 'c2')] }),
    ];
    render();
    expect(q('.empty-state')).toBeNull();
    expect(qa('[data-testid="volumes-pile"]')).toHaveLength(2);
    expect(q('[data-testid="survey-bulk-not-counted"]')?.textContent).toContain(
      'Pile n (no comparison)',
    );
    expect(calls.computeSeries).not.toHaveBeenCalledWith('n');
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
      pile('a', { folder: 'North', results: [result(100, 'c2')] }),
      pile('b', { folder: 'South', results: [result(7, 'c2')] }),
    ];
    render();
    const filter = q('[data-testid="volumes-folder"]') as HTMLSelectElement;
    expect([...filter.options].map((o) => o.textContent)).toEqual(['All piles', 'North', 'South']);
    expect(tableCells()[1]?.[0]).toBe(v(107));
    act(() => {
      filter.value = 'South';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(qa('[data-testid="volumes-pile"]')).toHaveLength(1);
    expect(tableCells()[1]?.[0]).toBe(v(7));
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
      // the kit's dates run to c2: j is carried on both
      pile('j', {
        series: [
          result(5, 'c1', { carried: { pile: 'p2', base: 'tin' } as never }),
          result(6, 'c2', { carried: { pile: 'p2', base: 'tin' } as never }),
        ],
        results: [],
      }),
    ];
    render();
    const cells = qa('[data-testid="volumes-inventory-table"] tbody tr').map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(cells[0]?.[0]).toBe(v(145));
    expect(cells[1]?.[0]).toBe(v(116));
    expect(cells[1]?.[2]).toContain('Pile k (no survey data)');
    expect(q('[data-testid="time-missing"]')?.textContent).toContain('1 pile has no survey data');
    // the dates are worked out for the piles shown
    expect(calls.computeSeries).toHaveBeenCalledWith('a');
  });

  it('one site total: a stale figure is named in both totals, never added', () => {
    // b's stored figure is stale by its fingerprint: before, the stack added it and the total did not
    s.measure.file.measurements = [
      pile('a', { results: [result(120, 'c2')] }),
      pile('b', { results: [result(30, 'c2')] }),
    ];
    stale.stored.add('b');
    render();
    expect(q('[data-testid="survey-bulk-net"]')?.textContent).toBe(v(120));
    expect(tableCells()[1]?.[0]).toBe(v(120));
    expect(tableCells()[1]?.[2]).toBe('Pile b (stale)');
    expect(q('[data-testid="survey-bulk-not-counted"]')?.textContent).toContain('Pile b (stale)');
    // a per-date figure the series check calls stale is left out the same way
    stale.stored.clear();
    stale.series.add('a');
    s.measure.file = {
      measurements: [pile('a', { series: [result(100, 'c1')], results: [result(120, 'c2')] })],
    };
    render();
    expect(tableCells()[0]?.[0]).toBe('Not counted');
    expect(tableCells()[0]?.[2]).toBe('Pile a (stale)');
  });

  it('one site total: an older stored figure is not the latest total', () => {
    // a's stored figure is for c1; the latest survey is c2, where a has none yet
    s.measure.file.measurements = [
      pile('a', { results: [result(500, 'c1')] }),
      pile('b', { results: [result(30, 'c2')] }),
    ];
    render();
    const heading = q('[data-testid="survey-bulk"] h2')?.textContent;
    expect(heading).toBe('Total on 10 Feb');
    expect(q('[data-testid="survey-bulk-net"]')?.textContent).toBe(v(30));
    expect(tableCells()[1]?.[0]).toBe(v(30));
    expect(tableCells()[1]?.[2]).toBe('Pile a (not computed yet)');
  });

  it('no false zero: nothing counted on the latest date shows no figure, with why', () => {
    // a has a figure on c1 only; on the latest date (c2) nothing is counted
    s.measure.file.measurements = [pile('a', { series: [result(100, 'c1')] })];
    render();
    expect(q('[data-testid="survey-bulk"] h2')?.textContent).toBe('Total on 10 Feb');
    expect(q('[data-testid="survey-bulk-net"]')?.textContent).toBe('-');
    expect(q('[data-testid="survey-bulk-area"]')?.textContent).toBe('-');
    expect(q('[data-testid="survey-bulk-not-counted"]')?.textContent).toBe(
      '1 pile not counted: Pile a (not computed yet)',
    );
    // the table's latest row is the same date the total names
    const latest = q('[data-testid="volumes-inventory-table"] tr[data-latest]');
    expect(latest?.getAttribute('data-capture')).toBe('c2');
    expect(latest?.querySelector('td')?.textContent).toBe('Not counted');
  });

  it('no false zero: without a survey date there is no figure, and every pile is named', () => {
    s.compare.captures = [];
    s.measure.file.measurements = [pile('a', { results: [result(100, 'c1')] })];
    render();
    expect(q('[data-testid="survey-bulk"] h2')?.textContent).toBe('Total');
    expect(q('[data-testid="survey-bulk-net"]')?.textContent).toBe('-');
    expect(q('[data-testid="survey-bulk-not-counted"]')?.textContent).toBe(
      '1 pile not counted: Pile a (no survey data)',
    );
    expect(q('[data-testid="volumes-inventory"]')).toBeNull();
  });

  it('the area adds only the counted piles', () => {
    s.measure.file.measurements = [
      pile('a', { results: [result(10, 'c2')] }),
      pile('b', {
        points: [
          [0, 0, 0],
          [20, 0, 0],
          [20, 20, 0],
        ],
        results: [result(5, 'c2')],
      }),
    ];
    stale.stored.add('b');
    render();
    expect(q('[data-testid="survey-bulk-area"]')?.textContent).toBe(
      formatQuantity(50, 'area', settings.units, settings.precision),
    );
  });

  it('a date the series ran for without a figure has no survey data', () => {
    s.compare.seriesCurrent = { a: { 'a c1': 'sha256:c1', 'a c2': 'sha256:c2' } };
    s.measure.file.measurements = [pile('a', { results: [result(10, 'c2')] })];
    render();
    expect(tableCells()[0]?.[2]).toBe('Pile a (no survey data)');
  });

  it('totals use the site units and locale, not a pile override', () => {
    const imperial = {
      ...settings,
      locale: 'imperial' as const,
      units: { ...settings.units, volume: 'yd3' as const },
    };
    s.measure.settings = imperial;
    s.measure.file.measurements = [
      pile('a', { units: { volume: 'L' }, results: [result(12345.6, 'c2')] }),
    ];
    render();
    const want = formatQuantity(12345.6, 'volume', imperial.units, imperial.precision, 'imperial');
    expect(want).toContain('yd');
    expect(q('[data-testid="survey-bulk-net"]')?.textContent).toBe(want);
    expect(tableCells()[1]?.[0]).toBe(want);
  });

  it('the change counts only piles on both dates, and says how many', () => {
    s.measure.file.measurements = [
      pile('a', { series: [result(100, 'c1')], results: [result(110, 'c2')] }),
      pile('b', { series: [result(50, 'c1')], results: [result(0, 'c2', { status: 'refused' })] }),
      pile('c', { results: [result(9, 'c2')] }),
    ];
    render();
    // b is gone on c2 and c is new: the change is a's +10, over 1 of 3 piles (never b as zero)
    expect(tableCells()[1]?.[1]).toBe(`+${v(10)} (1 of 3 piles)`);
    expect(tableCells()[1]?.[0]).toBe(v(119));
  });

  it('marks partial figures and names failed runs with why', async () => {
    calls.computeSeries.mockImplementation((id: string) =>
      id === 'f' ? Promise.reject(new Error('the engine stopped')) : Promise.resolve(false),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    s.measure.file.measurements = [
      pile('a', { results: [result(40, 'c2', { status: 'partial' })] }),
      pile('f', { series: [result(10, 'c1')] }),
    ];
    render();
    await flush();
    const latest = q('[data-testid="volumes-inventory-table"] tr[data-capture="c2"]');
    expect(latest?.hasAttribute('data-partial')).toBe(true);
    expect(latest?.textContent).toContain('Partly outside the survey: Pile a');
    expect(latest?.textContent).toContain('Pile f (could not compute: the engine stopped)');
    expect(latest?.textContent).not.toContain('no survey data');
    expect(q('[data-testid="survey-bulk-partial"]')?.textContent).toContain('Pile a');
  });

  it('works out only the piles that changed', () => {
    s.measure.file.measurements = [pile('a'), pile('b')];
    render();
    expect(calls.computeSeries).toHaveBeenCalledTimes(1);
    return flush().then(() => {
      expect(calls.computeSeries.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
      calls.computeSeries.mockClear();
      s.measure.file = {
        measurements: [pile('a'), pile('b', { updatedAt: '2026-10-06T00:00:00.000Z' })],
      };
      render();
      return flush().then(() => {
        expect(calls.computeSeries.mock.calls.map((c) => c[0])).toEqual(['b']);
      });
    });
  });

  it('works every pile out again once Prepare surfaces brings surfaces', async () => {
    s.measure.file.measurements = [pile('a'), pile('b')];
    render();
    await flush();
    expect(calls.computeSeries.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    calls.computeSeries.mockClear();
    // nothing changed: no run
    render();
    await flush();
    expect(calls.computeSeries).not.toHaveBeenCalled();
    // the prepare job read the surfaces back: the runs made without them are redone
    s.compare = {
      ...s.compare,
      surfaces: [
        { id: 's1', capture: 'c1', fingerprint: 'f1' },
        { id: 's2', capture: 'c2', fingerprint: 'f2' },
      ],
    };
    render();
    await flush();
    expect(calls.computeSeries.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('heads the inventory one level under the sidebar heading (h2), never skipping one', () => {
    s.measure.file.measurements = [pile('a', { results: [result(10, 'c2')] })];
    render();
    expect(q('[data-testid="volumes-inventory"] .vd-sub')?.tagName).toBe('H3');
  });

  it('clicking a pile opens it in the pile panel, in place of the list', () => {
    s.measure.file.measurements = [pile('a'), pile('b'), pile('c', { folder: 'North' })];
    render();
    expect(q('[data-testid="pile-panel"]')).toBeNull();
    click(qa('[data-testid="volumes-pile"]')[1]);
    expect(calls.select).toHaveBeenCalledWith(['b'], 'b');
    // the pick is the view's own: the sidebar leaves the view in front
    expect(takeVolumesPick('b')).toBe(true);
    s.measure.focus = 'b';
    s.measure.selected = ['b'];
    render();
    const panel = q('[data-testid="pile-panel"]');
    expect(panel?.getAttribute('data-id')).toBe('b');
    // Pile n of N steps through the piles in the inventory's order
    expect(panel?.getAttribute('data-order')).toBe('a,b,c');
    expect(q('[data-testid="volumes-pile"]')).toBeNull();
    expect(q('[data-testid="volumes-inventory"]')).toBeNull();
  });

  it('a focus on something other than a pile keeps the list', () => {
    s.measure.file.measurements = [pile('a')];
    s.measure.focus = 'not-a-pile';
    render();
    expect(q('[data-testid="pile-panel"]')).toBeNull();
    expect(qa('[data-testid="volumes-pile"]').length).toBe(1);
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

  it('the CSV says stale for a stale figure, as the cards and the totals do', async () => {
    s.measure.file.measurements = [
      pile('a', { series: [result(8, 'c1')], results: [result(10, 'c2')] }),
    ];
    stale.stored.add('a');
    render();
    await act(async () => {
      button('CSV')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const req = calls.saveFile.mock.calls.at(-1)?.[1];
    const lines = req?.data.split(/\r?\n/) ?? [];
    expect(lines.find((l) => l.includes('2026-02-10'))).toMatch(/,stale,/);
    expect(lines.find((l) => l.includes('2026-01-10'))).toMatch(/,ok,/);
    stale.stored.clear();
  });
});
