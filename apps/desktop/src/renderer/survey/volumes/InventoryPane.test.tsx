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
  openPile: vi.fn(),
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
vi.mock('../compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel(s.compare),
  isStale: (_s: unknown, m: { id: string }) => stale.stored.has(m.id),
  seriesStale: (m: { id: string }) => stale.series.has(m.id),
  computeSeries: calls.computeSeries,
  computeAll: calls.computeAll,
  recomputeCarried: vi.fn(() => Promise.resolve([])),
  hasCarried: (m: SurveyMeasurement) => m.results.some((r) => r.carried !== undefined),
  keepsCarried: (m: SurveyMeasurement) => m.results.some((r) => r.carried !== undefined),
}));
vi.mock('../measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  measureFolders: (file: { measurements: SurveyMeasurement[] }) =>
    [...new Set(file.measurements.flatMap((m) => (m.folder ? [m.folder] : [])))].sort(),
  knownTemplates: () => [],
  replaceMeasurement: vi.fn(),
  renameMeasurement: vi.fn(),
  select: calls.select,
  startTool: calls.startTool,
}));
vi.mock('../card/VolumeDetail', () => ({
  VolumeDetail: ({ m }: { m: SurveyMeasurement }) => (
    <div data-testid="volume-detail" data-id={m.id} />
  ),
}));
// the panel's own slots: the detail card is the same card as the measurement panel's
vi.mock('../card/slots', () => ({
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
vi.mock('../pile/PilePanel', () => ({
  PilePanel: ({ id, order }: { id: string; order?: readonly string[] }) => (
    <div data-testid="pile-panel" data-id={id} data-order={(order ?? []).join(',')} />
  ),
}));
vi.mock('../card/CardActions', () => ({
  CardActions: () => null,
  CardMenu: () => null,
  NOTES_MAX: 4000,
}));
vi.mock('../../shell', () => ({
  bridge: { call: calls.saveFile },
  useShell: (sel: (x: unknown) => unknown) => sel({ pkg: null }),
}));
vi.mock('../../processing/store', () => ({
  processing: { getState: () => ({ openDialog: calls.openDialog }) },
}));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => false }));
// the date in focus (the notch's): null is the latest survey date
const focusDate = vi.hoisted(() => ({ capture: null as string | null }));
vi.mock('../../workspace/timeline', () => ({
  useTimeline: (sel: (x: unknown) => unknown) => sel({ focus: focusDate.capture }),
}));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { id: 'p1', root: 'C:/p', manifest: { captures: [], layers: [] } } }),
  assetUrl: (id: string, ref: { path: string }) => `aio://project/${id}/${ref.path}`,
}));
vi.mock('../pile/openPile', () => ({ openPile: calls.openPile }));
// the other panes have their own tests
vi.mock('./CutFillPane', () => ({
  CutFillPane: ({ onPile }: { onPile?: (id: string) => void }) => (
    <div data-testid="cutfill-pane" data-picks={onPile ? 'yes' : 'no'} />
  ),
}));
vi.mock('./MaterialsPane', () => ({ MaterialsPane: () => <div data-testid="materials-pane" /> }));
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ ok: job.exists })),
);

const { VolumesBench } = await import('../../workspace/workbench/benches/VolumesBench');
const { volumesPane } = await import('./volumesPane');
const { volumeParts } = await import('../pile/PileHeader');

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
    root?.render(<VolumesBench />);
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
/** A volume as the table writes it (the number, the unit in the column head). */
const num = (x: number, st: SurveySettings = settings) =>
  volumeParts(x, st.units, st.precision.volume, st.locale ?? 'metric').num;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
/** A pile's row in the table: its name and its figures. */
const pileRow = (id: string) => {
  const tr = q(`[data-testid="volumes-pile"][data-id="${id}"]`);
  return tr ? [...tr.querySelectorAll('th, td')].map((c) => c.textContent) : null;
};
const total = () =>
  [...(q('[data-testid="volumes-site-total"]')?.querySelectorAll('th, td') ?? [])].map(
    (c) => c.textContent,
  );
const kpi = (which: 'volume' | 'tonnes' | 'change') =>
  q(`[data-testid="volumes-kpi-${which}"]`)?.textContent ?? null;
const status = () => q('[data-testid="volumes-status"]')?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  stale.stored.clear();
  stale.series.clear();
  job.exists = true;
  focusDate.capture = null;
  volumesPane.setState({ pane: 'inventory' });
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

describe('the Volumes tab without a pile', () => {
  it('says so and offers Draw volume and Detect piles', async () => {
    s.measure.file.measurements = [{ ...pile('x'), tool: 'area' }];
    render();
    await flush();
    const empty = q('.empty-state');
    expect(empty?.textContent).toContain('No stockpiles yet');
    expect(empty?.textContent).toContain('stockpile pipeline');
    expect(q('[data-testid="volumes-inventory"]')).toBeNull();
    expect(q('[data-testid="volumes-header"]')).toBeNull();
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

  it('the Materials pane still opens with no pile (materials come first)', () => {
    volumesPane.setState({ pane: 'materials' });
    render();
    expect(q('[data-testid="materials-pane"]')).not.toBeNull();
    expect(q('.empty-state')).toBeNull();
  });
});

describe('Inventory', () => {
  const MATERIALS = [
    { id: 'm1', name: 'Aggregate', densityTPerM3: 2 },
    { id: 'm2', name: 'Sand', densityTPerM3: 1.5 },
  ];

  it('groups by material with subtotals, four piles then "+ 2 more", and Site total', () => {
    s.measure.settings = { ...settings, materials: MATERIALS };
    s.measure.file.measurements = [
      ...[60, 50, 40, 30, 20, 10].map((x, i) =>
        pile(`g${String(i)}`, { material: 'm1', results: [result(x, 'c2')] }),
      ),
      pile('s', { material: 'm2', results: [result(400, 'c2')] }),
      pile('n', { results: [result(5, 'c2')] }),
    ];
    render();
    const groups = qa('[data-testid="volumes-group"]').map((g) => g.getAttribute('data-material'));
    // the largest material first, No material last
    expect(groups).toEqual(['m2', 'm1', '']);
    const agg = q('[data-testid="volumes-group"][data-material="m1"]');
    expect(agg?.textContent).toContain('Aggregate');
    expect(agg?.textContent).toContain('2.00 t/m³');
    expect([...(agg?.querySelectorAll('td') ?? [])].map((c) => c.textContent)).toEqual([
      num(210),
      '420',
      '',
    ]);
    expect(q('[data-testid="volumes-group"][data-material=""]')?.textContent).toContain(
      'No material',
    );
    // four piles shown, the two smallest behind "+ 2 more", which opens them
    const shown = qa('[data-testid="volumes-pile"]:not([hidden])').map((r) =>
      r.getAttribute('data-id'),
    );
    expect(shown).toEqual(['s', 'g0', 'g1', 'g2', 'g3', 'n']);
    // every pile is in the table, the folded ones hidden
    expect(qa('[data-testid="volumes-pile"]')).toHaveLength(8);
    click(button('+ 2 more'));
    expect(qa('[data-testid="volumes-pile"]:not([hidden])')).toHaveLength(8);
    expect(button('+ 2 more')).toBeUndefined();
    // No material has no tonnes; the site total adds every counted pile
    expect(pileRow('n')).toEqual(['Pile n', num(5), '-', '']);
    expect(total()).toEqual(['Site total', num(615), '1 020', '']);
  });

  it('says during playback that the figures are the last survey passed', async () => {
    const { datesPlayer } = await import('../../workspace/dates/datesPlayer');
    s.measure.file.measurements = [pile('a', { results: [result(10, 'c2')] })];
    render();
    expect(q('[data-testid="volumes-playback-note"]')).toBeNull();
    act(() => {
      datesPlayer.setState({
        playing: true,
        t: 1,
        frame: { t: 1, passed: 0, next: 2, f: 0.5, ended: false },
      });
    });
    expect(q('[data-testid="volumes-playback-note"]')?.textContent).toBe(
      'During playback the panel shows the last survey the playhead passed. Nothing is interpolated between surveys.',
    );
    act(() => {
      datesPlayer.setState({ playing: false, frame: null, t: null });
    });
  });

  it('shows each pile on the date in focus with its change since the previous survey', () => {
    s.measure.settings = { ...settings, materials: MATERIALS };
    s.measure.file.measurements = [
      pile('a', { material: 'm1', series: [result(100, 'c1')], results: [result(120, 'c2')] }),
      pile('b', { material: 'm1', series: [result(7, 'c1')], results: [result(3, 'c2')] }),
    ];
    render();
    expect(q('.vi-cap')?.textContent).toContain('Δ vs 10 Jan 2026');
    expect(pileRow('a')).toEqual(['Pile a', num(120), '240', `+${num(20)}`]);
    expect(pileRow('b')).toEqual(['Pile b', num(3), '6', `−${num(4)}`]);
    expect(
      q('[data-testid="volumes-pile"][data-id="b"] td:last-child')?.getAttribute('data-sign'),
    ).toBe('loss');
    expect(total()).toEqual(['Site total', num(123), '246', `+${num(16)}`]);
    // the first survey: no change
    focusDate.capture = 'c1';
    render();
    expect(pileRow('a')).toEqual(['Pile a', num(100), '200', '']);
    expect(q('.vi-cap')?.textContent).not.toContain('Δ vs');
  });

  it('a pile the inventory leaves out is named under Not counted with why, never added', () => {
    s.measure.file.measurements = [
      pile('n', { items: [] }),
      pile('a', { results: [result(120, 'c2')] }),
      pile('b', { results: [result(30, 'c2')] }),
    ];
    stale.stored.add('b');
    render();
    expect(q('.empty-state')).toBeNull();
    expect(pileRow('b')?.[1]).toBe('stale');
    expect(pileRow('n')?.[1]).toBe('no comparison');
    expect(total()[1]).toBe(num(120));
    expect(kpi('volume')).toBe(`${num(120)} m³`);
    expect(status()).toContain('Pile b (stale)');
    expect(status()).toContain('Pile n (no comparison)');
    expect(calls.computeSeries).not.toHaveBeenCalledWith('n');
  });

  it('an older stored figure is not counted on the latest date', () => {
    s.measure.file.measurements = [
      pile('a', { results: [result(500, 'c1')] }),
      pile('b', { results: [result(30, 'c2')] }),
    ];
    render();
    expect(kpi('volume')).toBe(`${num(30)} m³`);
    expect(pileRow('a')?.[1]).toBe('not computed yet');
  });

  it('no false zero: nothing counted on the date shows no figure, with why', () => {
    s.measure.file.measurements = [pile('a', { series: [result(100, 'c1')] })];
    render();
    expect(kpi('volume')).toBe('-');
    expect(q('[data-testid="volumes-site-total"]')).toBeNull();
    expect(status()).toBe('1 pile not counted: Pile a (not computed yet)');
  });

  it('no false zero: without a survey date there is no figure, and every pile is named', () => {
    s.compare.captures = [];
    s.measure.file.measurements = [pile('a', { results: [result(100, 'c1')] })];
    render();
    expect(q('[data-testid="volumes-kpi"]')).toBeNull();
    expect(pileRow('a')).toEqual(['Pile a', 'No survey data']);
  });

  it('a date the series ran for without a figure has no survey data', () => {
    s.compare.seriesCurrent = { a: { 'a c1': 'sha256:c1', 'a c2': 'sha256:c2' } };
    s.measure.file.measurements = [pile('a', { results: [result(10, 'c2')] })];
    focusDate.capture = 'c1';
    render();
    expect(pileRow('a')?.[1]).toBe('no survey data');
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
    expect(q('[data-testid="volumes-pile"][data-id="a"] .vi-partial')).not.toBeNull();
    expect(status()).toContain('Partly outside the survey: Pile a');
    expect(pileRow('f')?.[1]).toBe('could not compute: the engine stopped');
  });

  it('uses the site units and locale, not a pile override', () => {
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
    expect(kpi('volume')).toBe(want);
    expect(q('.vi-table thead')?.textContent).toContain('yd³');
  });

  it('a row opens the pile panel in place of the tab, stepping in the table order', () => {
    s.measure.settings = { ...settings, materials: MATERIALS };
    s.measure.file.measurements = [
      pile('a', { results: [result(5, 'c2')] }),
      pile('b', { material: 'm1', results: [result(50, 'c2')] }),
      pile('c', { material: 'm1', results: [result(70, 'c2')] }),
    ];
    render();
    click(q('[data-testid="volumes-pile"][data-id="b"]'));
    expect(calls.openPile).toHaveBeenCalledWith('b');
    s.measure.focus = 'b';
    s.measure.selected = ['b'];
    render();
    const panel = q('[data-testid="pile-panel"]');
    expect(panel?.getAttribute('data-id')).toBe('b');
    expect(panel?.getAttribute('data-order')).toBe('c,b,a');
    expect(q('[data-testid="volumes-pile"]')).toBeNull();
    expect(q('[data-testid="volumes-header"]')).toBeNull();
    expect(q('[data-testid="volumes-segment"]')).toBeNull();
    // back (the panel's "‹ Inventory" clears the focus): the inventory again
    s.measure.focus = null;
    render();
    expect(qa('[data-testid="volumes-pile"]')).toHaveLength(3);
  });

  it('Enter on a row opens it too', () => {
    s.measure.file.measurements = [pile('a', { results: [result(5, 'c2')] })];
    render();
    const row = q('[data-testid="volumes-pile"]');
    act(() => {
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(calls.openPile).toHaveBeenCalledWith('a');
  });

  it('a focus on something other than a pile keeps the list', () => {
    s.measure.file.measurements = [pile('a')];
    s.measure.focus = 'not-a-pile';
    render();
    expect(q('[data-testid="pile-panel"]')).toBeNull();
    expect(qa('[data-testid="volumes-pile"]').length).toBe(1);
  });
});

describe('the piles worked out per date', () => {
  it('works out only the piles that changed', async () => {
    s.measure.file.measurements = [pile('a'), pile('b')];
    render();
    expect(calls.computeSeries).toHaveBeenCalledTimes(1);
    await flush();
    expect(calls.computeSeries.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    calls.computeSeries.mockClear();
    s.measure.file = {
      measurements: [pile('a'), pile('b', { updatedAt: '2026-10-06T00:00:00.000Z' })],
    };
    render();
    await flush();
    expect(calls.computeSeries.mock.calls.map((c) => c[0])).toEqual(['b']);
  });

  it('works every pile out again once Prepare surfaces brings surfaces', async () => {
    s.measure.file.measurements = [pile('a'), pile('b')];
    render();
    await flush();
    expect(calls.computeSeries.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    calls.computeSeries.mockClear();
    render();
    await flush();
    expect(calls.computeSeries).not.toHaveBeenCalled();
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

  it('keeps working them out on the other panes', async () => {
    volumesPane.setState({ pane: 'cutFill' });
    s.measure.file.measurements = [pile('a')];
    render();
    await flush();
    expect(calls.computeSeries).toHaveBeenCalledWith('a');
  });
});
