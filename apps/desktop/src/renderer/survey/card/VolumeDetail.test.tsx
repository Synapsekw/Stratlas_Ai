// @vitest-environment jsdom
import { formatQuantity } from '@aio/geo';
import {
  defaultSurveySettings,
  type ComparisonResult,
  type HeightTiles,
  type SurveyMeasurement,
  type SurveySettings,
} from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tiles = (id: string, capture: string): HeightTiles =>
  ({ id, name: `${capture} DSM`, capture, source: { kind: 'dsm', layer: id } }) as HeightTiles;

const s = vi.hoisted(() => ({
  compare: Object.create(null) as Record<string, unknown>,
  measure: {} as { settings: SurveySettings; readOnly: boolean; file: { measurements: unknown[] } },
  spread: null as { pct: number; nets: never[] } | null | 'computing',
  prepareRunning: false,
  states: new Map<
    string,
    { kind: 'ready' } | { kind: 'preparing'; pct: number } | { kind: 'none' }
  >(),
  surveys: [] as { id: string; date: string }[],
}));
const calls = vi.hoisted(() => ({
  compute: vi.fn(() => Promise.resolve(null)),
  computeSeries: vi.fn(() => Promise.resolve(false)),
  recomputeStandard: vi.fn(() => Promise.resolve(null as string | null)),
  prepareSurfaces: vi.fn(() => Promise.resolve(null as string | null)),
  prepareParams: vi.fn((): unknown => null),
  updateMeasurement: vi.fn(),
}));

vi.mock('../compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel(s.compare),
  useSpread: () => s.spread,
  isStale: () => false,
  seriesStale: () => false,
  compute: calls.compute,
  computeSeries: calls.computeSeries,
  recomputeStandard: calls.recomputeStandard,
  prepareSurfaces: calls.prepareSurfaces,
  prepareParams: calls.prepareParams,
}));
vi.mock('../measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  updateMeasurement: calls.updateMeasurement,
}));
vi.mock('../surfaceStates', () => ({
  usePrepareRunning: () => s.prepareRunning,
  useSurfaceStates: () => s.states,
  usePreparingSoon: () => false,
}));
vi.mock('../BaseEditor', () => ({ BaseEditor: () => <div data-testid="base-editor" /> }));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => false }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { manifest: { captures: s.surveys, layers: [] } } }),
}));

const { VolumeDetail, volumeStatusLine } = await import('./VolumeDetail');
const { setSeriesFailed } = await import('../useInventory');

const NOW = '2026-10-05T00:00:00.000Z';
const RING: [number, number, number][] = [
  [0, 0, 10],
  [10, 0, 10],
  [10, 10, 10],
  [0, 10, 10],
];

function result(over: Partial<ComparisonResult> = {}): ComparisonResult {
  return {
    item: 'a',
    status: 'ok',
    cutM3: 0,
    fillM3: 3482,
    netM3: 3482,
    totalM3: 3482,
    areaM2: 900,
    areaCutM2: 0,
    areaFillM2: 900,
    areaUnchangedM2: 0,
    uncoveredM2: 0,
    fromLabel: 'Triangulated toe',
    toLabel: '05 Oct',
    toCapture: 'c2',
    deadbandM: 0,
    usedDeadband: false,
    cellM: 0,
    engine: 'ts',
    fingerprint: 'fp',
    computedAt: NOW,
    ...over,
  };
}

function pile(over: Partial<SurveyMeasurement> = {}): SurveyMeasurement {
  return {
    id: 'm1',
    family: 'polygon',
    tool: 'volume',
    label: 'Pile 7',
    scope: { kind: 'site' },
    points: RING,
    items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: [result()],
    createdAt: NOW,
    ...over,
  };
}

const settings = (): SurveySettings => ({
  ...defaultSurveySettings(),
  materials: [{ id: 'mat1', name: '20 mm aggregate', densityTPerM3: 1.7 }],
});
const v = (x: number) => formatQuantity(x, 'volume', settings().units, settings().precision);
/** A figure in the over-time table: the number alone, its unit in the column's head. */
const bare = (x: number) => v(x).replace(/\s*m³$/, '');

beforeEach(() => {
  s.prepareRunning = false;
  s.surveys = [];
  s.compare = {
    status: 'ready',
    error: null,
    surfaces: [tiles('s1', 'c1'), tiles('s2', 'c2')],
    designs: [],
    captures: [
      { id: 'c1', label: '05 Sep', date: '2026-09-05' },
      { id: 'c2', label: '05 Oct', date: '2026-10-05' },
    ],
    computed: {},
    running: {},
    problems: {},
    current: {},
    preparing: null,
  };
  s.measure = { settings: settings(), readOnly: false, file: { measurements: [] } };
  s.spread = null;
  s.states = new Map();
  for (const f of Object.values(calls)) f.mockClear();
});

let root: Root | undefined;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

function mount(node: ReactNode) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

function show(m: SurveyMeasurement) {
  s.measure.file.measurements = [m];
  return mount(<VolumeDetail m={m} />);
}

const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('no element');
  act(() => {
    (el as HTMLElement).click();
  });
};
const byTestId = (id: string) => host.querySelectorAll(`[data-testid="${id}"]`);
const buttonNamed = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === name);

describe('VolumeDetail', () => {
  it('new volume defaults to Triangulated toe', () => {
    show(pile({ items: [], results: [] }));
    expect(byTestId('survey-from')[0]?.textContent).toContain('Base: Triangulated toe');
    click(byTestId('survey-recompute')[0]);
    expect(calls.updateMeasurement).toHaveBeenCalledTimes(1);
    const fn = calls.updateMeasurement.mock.calls[0]?.[1] as (
      m: SurveyMeasurement,
    ) => SurveyMeasurement;
    const next = fn(pile({ items: [], results: [] }));
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.from).toEqual({ kind: 'smart' });
    expect(next.items[0]?.to).toEqual({ kind: 'current' });
    expect(calls.compute).toHaveBeenCalledWith('m1');
  });

  it('carried result shows the kit note and the recompute button only with surfaces', () => {
    const carried = result({
      fingerprint: 'kit:p7:e1:tin',
      carried: { from: 'kit', base: 'tin', pile: 'p7', epoch: 'e1' },
      usedDeadband: true,
      deadbandM: 0.05,
    });
    const m = pile({ results: [carried] });
    show(m);
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'From an earlier version (kit, Triangulated toe)',
    );
    expect(buttonNamed('Recompute with the standard base')).toBeDefined();
    // no cut/fill area split and no method line for a carried figure
    expect(host.querySelector('[data-testid="survey-cmp-result"] .vd-area')).toBeNull();
    expect(byTestId('vol-method')).toHaveLength(0);
    click(buttonNamed('Recompute with the standard base'));
    expect(calls.recomputeStandard).toHaveBeenCalledWith('m1');

    act(() => root?.unmount());
    host.remove();
    s.compare.surfaces = [];
    show(m);
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'From an earlier version (kit, Triangulated toe)',
    );
    expect(buttonNamed('Recompute with the standard base')).toBeUndefined();

    act(() => root?.unmount());
    host.remove();
    s.compare.surfaces = [tiles('s1', 'c1')];
    s.measure.readOnly = true;
    show(m);
    expect(buttonNamed('Recompute with the standard base')).toBeUndefined();
  });

  it('after recompute the card shows was', () => {
    show(
      pile({
        previousResults: [{ netM3: 3070, totalM3: 3070, label: 'kit tin', replacedAt: NOW }],
      }),
    );
    expect(byTestId('vol-was')[0]?.textContent).toBe(`was ${v(3070)}`);
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('Up to date');
  });

  it('a recompute that cannot run says why in the status line', async () => {
    const carried = result({
      fingerprint: 'kit:p7:e1:tin',
      carried: { from: 'kit', base: 'tin', pile: 'p7', epoch: 'e1' },
    });
    s.compare.status = 'loading';
    show(pile({ results: [carried] }));
    click(buttonNamed('Recompute with the standard base'));
    expect(calls.recomputeStandard).not.toHaveBeenCalled();
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'The volume engine is still starting. Try again in a moment.',
    );

    act(() => root?.unmount());
    host.remove();
    s.compare.status = 'ready';
    show(pile({ results: [carried], points: RING.slice(0, 2) }));
    click(buttonNamed('Recompute with the standard base'));
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'Draw at least three points to compute a volume.',
    );

    act(() => root?.unmount());
    host.remove();
    calls.recomputeStandard.mockResolvedValueOnce('This project is read-only.');
    show(pile({ results: [carried] }));
    await act(async () => {
      buttonNamed('Recompute with the standard base')?.click();
      await Promise.resolve();
    });
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('This project is read-only.');
  });

  it('one status line, no ms timer', () => {
    s.compare.computed = {
      m1: { results: [result()], heat: [], shares: [], ms: 123, live: false, ringKey: '' },
    };
    show(pile());
    expect(byTestId('survey-cmp-status')).toHaveLength(1);
    expect(byTestId('survey-compute-ms')).toHaveLength(0);
    expect(host.textContent).not.toContain(' ms');
    expect(host.querySelectorAll('.notice')).toHaveLength(0);
  });

  it('no jargon', () => {
    show(
      pile({
        items: [
          { id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: true },
          { id: 'b', from: { kind: 'previous' }, to: { kind: 'current' }, useDeadband: false },
        ],
        results: [
          result({ uncoveredM2: 12, usedDeadband: true, deadbandM: 0.05 }),
          result({ item: 'b', cellM: 0.25, status: 'partial', reason: '12% outside' }),
        ],
      }),
    );
    const text = host.textContent;
    // the area with no data names its reason
    expect(text).toContain('Not measured on this date');
    expect(text).toContain('Ignore changes smaller than');
    expect(text).toContain('High precision');
    expect(text).toContain(`Grid ${formatQuantity(0.25, 'distance', settings().units, 3)}`);
    for (const word of [
      'deadband',
      'Deadband',
      'Not covered',
      'Exact (triangulated)',
      'TIN',
      ' ms',
    ])
      expect(text).not.toContain(word);
    // every option of the To picker in plain words too
    const options = [...host.querySelectorAll('option')].map((o) => o.textContent);
    for (const o of options) {
      expect(o).not.toMatch(/Smart|perimeter|TIN/);
    }
  });

  it('heads Volume over time one level under the sidebar heading (h2), never skipping one', () => {
    show(pile({ series: [result({ toCapture: 'c1', fingerprint: 'f1' })] }));
    const sub = host.querySelector('.vd-sub');
    expect(sub?.textContent).toBe('Volume over time');
    expect(sub?.tagName).toBe('H3');
  });

  it('a date without a figure says why, never "No survey data"', () => {
    s.compare.captures = [
      { id: 'c0', label: '05 Aug', date: '2026-08-05' },
      { id: 'c1', label: '05 Sep', date: '2026-09-05' },
      { id: 'c2', label: '05 Oct', date: '2026-10-05' },
    ];
    s.states = new Map([
      ['c0', { kind: 'preparing', pct: 40 }],
      ['c1', { kind: 'ready' }],
      ['c2', { kind: 'ready' }],
    ]);
    const series = [result({ toCapture: 'c2', netM3: 3482, totalM3: 3482, fingerprint: 'f2' })];
    show(pile({ series }));
    expect(host.querySelector('[data-gap="c0"]')?.textContent).toBe('Surface preparing');
    expect(host.querySelector('[data-gap="c1"]')?.textContent).toBe('Not measured on this date');
    const rows = [...host.querySelectorAll('[data-testid="vol-time-table"] tbody tr')];
    expect(rows[0]?.querySelector('td')?.textContent).toBe('Surface preparing');
    expect(host.textContent).not.toContain('No survey data');
  });

  it('the over-time table names each date in the short form and never wraps (bug 6)', () => {
    s.compare.captures = [
      { id: 'c1', label: 'Survey 5 September 2026', date: '2026-09-05' },
      { id: 'c2', label: 'Survey 5 October 2026', date: '2026-10-05' },
    ];
    const series = [
      result({ toCapture: 'c1', netM3: 3070, totalM3: 3070, fingerprint: 'f1' }),
      result({ toCapture: 'c2', netM3: 3482, totalM3: 3482, fingerprint: 'f2' }),
    ];
    show(pile({ series }));
    const dates = [...host.querySelectorAll('[data-testid="vol-time-table"] tbody th')];
    expect(dates.map((d) => d.textContent)).toEqual(['5 Sep', '5 Oct']);
    // the survey's own label stays on hand
    expect(dates[0]?.getAttribute('title')).toBe('Survey 5 September 2026');
    // the date, head and figure cells keep to one line at the panel's narrowest width
    const css = readFileSync(join(__dirname, '..', 'compare.css'), 'utf8');
    const rule = (sel: string) =>
      new RegExp(
        `(^|[},])\\s*${sel.replace(/[.[\]]/g, '\\$&')}\\s*[,{][^}]*white-space:\\s*nowrap`,
        'm',
      );
    expect(css).toMatch(rule('.vd-time-table th'));
    expect(css).toMatch(rule('.vd-time-table td'));
  });

  it('a wide over-time table scrolls in its own box and never widens the chart', () => {
    const series = [
      result({ toCapture: 'c1', netM3: 9519.8, totalM3: 9519.8, fingerprint: 'f1' }),
      result({ toCapture: 'c2', netM3: 6505.9, totalM3: 6505.9, fingerprint: 'f2' }),
    ];
    show(pile({ material: 'mat1', series }));
    const table = host.querySelector('[data-testid="vol-time-table"]');
    const box = table?.parentElement;
    expect(box?.classList.contains('vd-time-scroll')).toBe(true);
    // the box is the section's own child, beside the chart: the chart takes the section's width
    expect(box?.parentElement?.classList.contains('vd-time')).toBe(true);
    const css = readFileSync(join(__dirname, '..', 'compare.css'), 'utf8');
    const block = (sel: string) =>
      new RegExp(`(^|[},])\\s*${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(
        css,
      )?.[2] ?? '';
    expect(block('.vd-time-scroll')).toMatch(/overflow-x:\s*auto/);
    expect(block('.vd-time-scroll')).toMatch(/min-width:\s*0/);
    // one column no wider than the card: a table's min-content never stretches it
    expect(block('.vd-time')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('over-time table shows change and tonnage', () => {
    const series = [
      result({ toCapture: 'c1', netM3: 3070, totalM3: 3070, fingerprint: 'f1' }),
      result({ toCapture: 'c2', netM3: 3482, totalM3: 3482, fingerprint: 'f2' }),
    ];
    show(pile({ material: 'mat1', series }));
    const table = host.querySelector('[data-testid="vol-time-table"]');
    expect(
      [...(table?.querySelectorAll('th[scope="col"]') ?? [])].map((x) => x.textContent),
    ).toEqual(['Date', 'Volume (m³)', 'Change (m³)', 'Tonnage']);
    const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
    expect(rows).toHaveLength(2);
    const latest = rows[1];
    expect(latest?.hasAttribute('data-latest')).toBe(true);
    expect(rows[0]?.hasAttribute('data-latest')).toBe(false);
    const cells = [...(latest?.querySelectorAll('td') ?? [])].map((c) => c.textContent);
    // the unit once, in the head: the figures keep the card's width (the narrow panel)
    expect(cells[0]).toBe(bare(3482));
    expect(cells[1]).toBe(`+${bare(412)}`);
    // tonnes shown as tonnes (the formatter's mass is SI kilograms)
    expect(cells[2]).toBe('5 919.4 t');
    expect(byTestId('time-chart')).toHaveLength(1);
    const since = host.querySelector('[data-testid="vol-since"]');
    expect(since?.textContent).toContain('Since 05 Sep');
    expect(since?.textContent).toContain(`+${v(412)}`);
    expect(host.querySelector('[data-testid="vol-material"]')?.textContent).toContain(
      '20 mm aggregate',
    );

    // no material density: no tonnage column
    act(() => root?.unmount());
    host.remove();
    show(pile({ series }));
    const heads = [...host.querySelectorAll('[data-testid="vol-time-table"] th[scope="col"]')];
    expect(heads.map((x) => x.textContent)).toEqual(['Date', 'Volume (m³)', 'Change (m³)']);
  });

  it('each date weighs at the density on that date (review finding 2)', () => {
    s.surveys = [
      { id: 'c1', date: '2026-09-05' },
      { id: 'c2', date: '2026-10-05' },
    ];
    s.measure.settings = {
      ...settings(),
      materials: [
        {
          id: 'mat1',
          name: '20 mm aggregate',
          densityTPerM3: 1.7,
          densityHistory: [
            { fromCapture: 'c1', tPerM3: 1.5 },
            { fromCapture: 'c2', tPerM3: 1.7 },
          ],
        },
      ],
    };
    const series = [
      result({ toCapture: 'c1', netM3: 3070, totalM3: 3070, fingerprint: 'f1' }),
      result({ toCapture: 'c2', netM3: 3482, totalM3: 3482, fingerprint: 'f2' }),
    ];
    show(pile({ material: 'mat1', series }));
    const rows = [...host.querySelectorAll('[data-testid="vol-time-table"] tbody tr')];
    expect(rows[0]?.querySelectorAll('td')[2]?.textContent).toBe('4 605.0 t');
    expect(rows[1]?.querySelectorAll('td')[2]?.textContent).toBe('5 919.4 t');
  });

  it('tonnage is volume times density in tonnes, metric and imperial', () => {
    const at = (units: SurveySettings['units']) => {
      s.measure.settings = {
        ...settings(),
        units,
        materials: [{ id: 'm2', name: 'Fill', densityTPerM3: 2 }],
      };
      show(pile({ material: 'm2', results: [result({ netM3: 10, totalM3: 10 })] }));
      const cells = host.querySelectorAll('[data-testid="vol-time-table"] tr[data-latest] td');
      const text = cells[2]?.textContent;
      act(() => root?.unmount());
      host.remove();
      return text;
    };
    expect(at(defaultSurveySettings().units)).toBe('20.0 t');
    // 20 t is 22.05 short tons
    expect(
      at({
        ...defaultSurveySettings().units,
        distance: 'ft',
        volume: 'yd3',
        density: 'ston/yd3',
        mass: 'ston',
      }),
    ).toBe('22.0 sh tn');
    show(pile());
  });

  it('keys series rows by the from date when an item has no to date', () => {
    const series = [
      result({ toCapture: undefined, fromCapture: 'c1', netM3: -20, fingerprint: 'f1' }),
      result({ toCapture: undefined, fromCapture: 'c2', netM3: -35, fingerprint: 'f2' }),
    ];
    show(
      pile({
        items: [
          {
            id: 'a',
            from: { kind: 'current' },
            to: { kind: 'design', design: 'd1', layer: 'l1' },
            useDeadband: false,
          },
        ],
        results: [result({ toCapture: undefined, fromCapture: 'c2', netM3: -35 })],
        series,
      }),
    );
    const rows = [...host.querySelectorAll('[data-testid="vol-time-table"] tbody tr')];
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual([bare(-20), bare(-35)]);
  });

  it('a pile absent on the latest date shows as absent', () => {
    const series = [
      result({
        toCapture: 'c1',
        netM3: 3070,
        fingerprint: 'kit:p7:e1:tin',
        carried: { from: 'kit', base: 'tin', pile: 'p7', epoch: 'e1' },
      }),
    ];
    show(pile({ results: [], series }));
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('Not measured on this date');
    const rows = [...host.querySelectorAll('[data-testid="vol-time-table"] tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.querySelector('td')?.textContent).toBe('Not measured on this date');
  });

  it('the heat map run on focus is not an edit: absent stays absent, current stays up to date', () => {
    const series = [
      result({
        toCapture: 'c1',
        netM3: 3070,
        fingerprint: 'kit:p7:e1:tin',
        carried: { from: 'kit', base: 'tin', pile: 'p7', epoch: 'e1' },
      }),
    ];
    // the run for the heat map only (stored results current): live, heatOnly, carried left out
    const heatRun = (results: ReturnType<typeof result>[]) => ({
      m1: { results, heat: [], shares: [], ms: 1, live: true, heatOnly: true, ringKey: '' },
    });
    s.compare.computed = heatRun([]);
    show(pile({ results: [], series }));
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('Not measured on this date');
    act(() => root?.unmount());
    host.remove();
    s.compare.computed = heatRun([result()]);
    show(pile());
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('Up to date');
  });

  it('spread hint formats ±1.8 % across bases', () => {
    s.spread = { pct: 1.8, nets: [] };
    show(pile());
    expect(byTestId('vol-spread')[0]?.textContent).toBe('±1.8 % across bases');

    // still being worked out (or none: a base outside the spread bases, a carried figure, which
    // `spreadItem` rules out in compareStore): no hint
    act(() => root?.unmount());
    host.remove();
    s.spread = 'computing';
    show(pile());
    expect(byTestId('vol-spread')).toHaveLength(0);
  });

  it('shows the prepare empty state when no surface is prepared', () => {
    s.compare.surfaces = [];
    show(pile({ results: [] }));
    expect(host.textContent).toContain('No survey surface is prepared yet');
    expect(byTestId('survey-prepare')).toHaveLength(1);
    click(byTestId('survey-prepare')[0]);
    expect(calls.prepareSurfaces).toHaveBeenCalledTimes(1);
  });

  it('a stored figure wins its own date over an older series row', () => {
    const series = [
      result({ toCapture: 'c1', netM3: 3070, totalM3: 3070, fingerprint: 'f1' }),
      result({ toCapture: 'c2', netM3: 3400, totalM3: 3400, fingerprint: 'old' }),
    ];
    show(pile({ series, results: [result({ netM3: 3482 })] }));
    const net = host.querySelector('[data-testid="survey-cmp-result"] tr[data-key="net"] td');
    expect(net?.textContent).toBe(v(3482));
    const latest = host.querySelector('[data-testid="vol-time-table"] tr[data-latest] td');
    expect(latest?.textContent).toBe(bare(3482));
    expect(host.querySelector('[data-testid="vol-since"] dd')?.textContent).toBe(`+${v(412)}`);
  });

  it('a series that fails says so in the status line', async () => {
    calls.computeSeries.mockRejectedValueOnce(new Error('worker died'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    show(pile());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'The volume over time could not be worked out. Try Recompute.',
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads the one failure record the totals read (setSeriesFailed)', async () => {
    // the volumes view's run failed; the card's own run is still going
    calls.computeSeries.mockReturnValueOnce(new Promise<boolean>(() => undefined));
    const m = pile();
    setSeriesFailed(m.id, 'worker died');
    show(m);
    await act(async () => {
      await Promise.resolve();
    });
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'The volume over time could not be worked out. Try Recompute.',
    );
    act(() => {
      setSeriesFailed(m.id, null);
    });
    expect(byTestId('survey-cmp-status')[0]?.textContent ?? '').not.toContain('could not');
  });

  it('Prepare waits while a prepare job, the background one included, is at work', () => {
    s.compare.surfaces = [];
    s.prepareRunning = true;
    show(pile({ results: [] }));
    const button = byTestId('survey-prepare')[0];
    expect(button?.getAttribute('aria-busy')).toBe('true');
    click(button);
    expect(calls.prepareSurfaces).not.toHaveBeenCalled();
  });

  it('without surfaces a carried pile reaches Prepare surfaces from its status row', () => {
    s.compare.surfaces = [];
    const carried = result({
      fingerprint: 'kit:p7:e1:tin',
      carried: { from: 'kit', base: 'tin', pile: 'p7', epoch: 'e1' },
    });
    show(pile({ results: [carried] }));
    expect(host.querySelectorAll('.vd-status-row [data-testid="survey-prepare"]')).toHaveLength(1);
    expect(byTestId('survey-prepare')).toHaveLength(1);
  });

  it('without surfaces a stale pile reaches Prepare surfaces from its status row', () => {
    s.compare.surfaces = [];
    show(pile({ results: [result({ status: 'stale' })] }));
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('Stale, recompute');
    expect(host.querySelectorAll('.vd-status-row [data-testid="survey-prepare"]')).toHaveLength(1);
  });

  it('a carried item keeps Ignore changes smaller than read-only, with a hint', () => {
    const carried = result({
      fingerprint: 'kit:p7:e1:tin',
      carried: { from: 'kit', base: 'tin', pile: 'p7', epoch: 'e1' },
    });
    show(pile({ results: [carried] }));
    const box = host.querySelector<HTMLInputElement>('[data-testid="survey-use-deadband"]');
    const value = host.querySelector<HTMLInputElement>('[data-testid="survey-deadband"]');
    expect(box?.disabled).toBe(true);
    expect(value?.readOnly).toBe(true);
    expect(byTestId('vol-ignore-carried')[0]?.textContent).toBe(
      'Recompute with the standard base to change this',
    );
    // not carried: editable, no hint
    act(() => root?.unmount());
    host.remove();
    show(pile());
    expect(
      host.querySelector<HTMLInputElement>('[data-testid="survey-use-deadband"]')?.disabled,
    ).toBe(false);
    expect(byTestId('vol-ignore-carried')).toHaveLength(0);
  });

  it('the why clears when the engine turns ready, and errors share the one status line', () => {
    const carried = result({
      fingerprint: 'kit:p7:e1:tin',
      carried: { from: 'kit', base: 'tin', pile: 'p7', epoch: 'e1' },
    });
    const m = pile({ results: [carried] });
    s.compare.status = 'loading';
    show(m);
    click(buttonNamed('Recompute with the standard base'));
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'The volume engine is still starting. Try again in a moment.',
    );
    s.compare.status = 'ready';
    act(() => root?.render(<VolumeDetail m={m} />));
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'From an earlier version (kit, Triangulated toe)',
    );

    s.compare.error = 'The surfaces could not be prepared.';
    act(() => root?.render(<VolumeDetail m={m} />));
    expect(byTestId('survey-cmp-status')).toHaveLength(1);
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'The surfaces could not be prepared.',
    );
    expect(host.querySelector('.vd-note')).toBeNull();
  });

  it('the new-volume placeholder has its own test id', () => {
    show(pile({ items: [], results: [] }));
    expect(byTestId('vol-new-item')).toHaveLength(1);
    expect(byTestId('survey-cmp-item')).toHaveLength(0);
  });

  it('a missing survey reads Missing survey, not its id', () => {
    show(
      pile({
        items: [
          {
            id: 'a',
            from: { kind: 'previous' },
            to: { kind: 'survey', surface: 'gone-dsm' },
            useDeadband: false,
          },
        ],
      }),
    );
    const to = host.querySelector<HTMLSelectElement>('[data-testid="survey-to"]');
    expect(to?.selectedOptions[0]?.textContent).toBe('Missing survey');
    expect(host.textContent).not.toContain('gone-dsm');
  });

  it('a To side on a fixed level or a custom base can be edited again', () => {
    const m = pile({
      items: [
        {
          id: 'a',
          from: { kind: 'current' },
          to: { kind: 'reference', mode: 'level', levelM: 102.5 },
          useDeadband: false,
        },
      ],
    });
    show(m);
    const level = host.querySelector<HTMLInputElement>('[data-testid="survey-to-level"]');
    expect(level?.value).toBe('102.500');
    // named for its side: the level the survey is compared with
    expect(level?.getAttribute('aria-label')).toBe('Fixed level compared with (m)');
    act(() => {
      if (!level) return;
      // React hears the value only through the input's own setter
      Reflect.set(HTMLInputElement.prototype, 'value', '101.25', level);
      level.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(calls.updateMeasurement).toHaveBeenCalled();
    const update = calls.updateMeasurement.mock.calls.at(-1) as unknown as [
      string,
      (x: SurveyMeasurement) => SurveyMeasurement,
    ];
    expect(update[1](m).items[0]?.to).toEqual({ kind: 'reference', mode: 'level', levelM: 101.25 });
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    // a custom base on the To side shows its point editor
    show(
      pile({
        items: [
          {
            id: 'a',
            from: { kind: 'current' },
            to: { kind: 'custom', vertices: [] } as never,
            useDeadband: false,
          },
        ],
      }),
    );
    expect(byTestId('base-editor')).toHaveLength(1);
  });

  it('the card row reads "Cut + fill", never "Total" (a total is a sum of nets)', () => {
    show(pile({ results: [result({ cutM3: 120, fillM3: 3602, netM3: 3482, totalM3: 3722 })] }));
    const row = host.querySelector('[data-testid="survey-cmp-result"] tr[data-key="total"]');
    expect(row?.querySelector('th')?.textContent).toBe('Cut + fill');
    expect(row?.querySelector('td')?.textContent).toBe(v(3722));
    const heads = [...host.querySelectorAll('[data-testid="survey-cmp-result"] th')];
    expect(heads.map((x) => x.textContent)).not.toContain('Total');
  });

  it('a stale stored figure still owns its date: one number, marked stale', () => {
    const series = [
      result({ toCapture: 'c1', netM3: 3070, totalM3: 3070, fingerprint: 'f1' }),
      result({ toCapture: 'c2', netM3: 3400, totalM3: 3400, fingerprint: 'older' }),
    ];
    show(pile({ series, results: [result({ netM3: 3482, status: 'stale' })] }));
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('Stale, recompute');
    const figures = host.querySelector('[data-testid="survey-cmp-result"]');
    expect(figures?.hasAttribute('data-stale')).toBe(true);
    expect(figures?.querySelector('tr[data-key="net"] td')?.textContent).toBe(v(3482));
    const latest = host.querySelector('[data-testid="vol-time-table"] tr[data-latest]');
    expect(latest?.querySelector('td')?.textContent).toBe(bare(3482));
    expect(latest?.hasAttribute('data-stale')).toBe(true);
    expect(host.querySelector('[data-testid="vol-since"] dd')?.textContent).toBe(`+${v(412)}`);
    // the older figure for that date is nowhere on the card
    expect(host.textContent).not.toContain(v(3400));
  });

  it('a failed series clears when its inputs change, and refused or stale come first', async () => {
    calls.computeSeries.mockRejectedValueOnce(new Error('worker died'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const m = pile();
    show(m);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe(
      'The volume over time could not be worked out. Try Recompute.',
    );
    // the outline edited: another series run, the old failure no longer holds
    const edited = { ...m, updatedAt: '2026-10-06T00:00:00.000Z' };
    s.measure.file.measurements = [edited];
    await act(async () => {
      root?.render(<VolumeDetail m={edited} />);
      await Promise.resolve();
    });
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('Up to date');
    warn.mockRestore();

    const idle = { computing: false, live: false, stale: false, seriesFailed: true };
    expect(volumeStatusLine(result({ status: 'refused' }), idle).text).toBe(
      'Not computed: the survey does not cover it',
    );
    expect(volumeStatusLine(result(), { ...idle, stale: true }).text).toBe('Stale, recompute');
    expect(volumeStatusLine(result(), idle).text).toBe(
      'The volume over time could not be worked out. Try Recompute.',
    );
  });

  it('works the volume over time out again once Prepare surfaces brings surfaces', async () => {
    s.compare.surfaces = [];
    const m = pile();
    show(m);
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.computeSeries).toHaveBeenCalledTimes(1);
    // the same inputs again: no second run
    await act(async () => {
      root?.render(<VolumeDetail m={m} />);
      await Promise.resolve();
    });
    expect(calls.computeSeries).toHaveBeenCalledTimes(1);
    // the prepare job read the surfaces back: the run made without them is redone
    s.compare.surfaces = [tiles('s1', 'c1'), tiles('s2', 'c2')];
    await act(async () => {
      root?.render(<VolumeDetail m={m} />);
      await Promise.resolve();
    });
    expect(calls.computeSeries).toHaveBeenCalledTimes(2);
  });

  it('a prepare note that nothing is left is neutral; a failure warns', async () => {
    s.compare.surfaces = [];
    calls.prepareSurfaces.mockResolvedValueOnce('Every survey surface is prepared.');
    calls.prepareParams.mockReturnValueOnce(null);
    show(pile({ results: [result({ status: 'stale' })] }));
    await act(async () => {
      byTestId('survey-prepare')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    let line = byTestId('survey-cmp-status')[0];
    expect(line?.textContent).toBe('Every survey surface is prepared.');
    expect(line?.getAttribute('data-tone')).toBe('muted');

    act(() => root?.unmount());
    host.remove();
    calls.prepareSurfaces.mockResolvedValueOnce('The job could not start.');
    calls.prepareParams.mockReturnValueOnce({ surfaces: [] });
    show(pile({ results: [result({ status: 'stale' })] }));
    await act(async () => {
      byTestId('survey-prepare')[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    line = byTestId('survey-cmp-status')[0];
    expect(line?.textContent).toBe('The job could not start.');
    expect(line?.getAttribute('data-tone')).toBe('warn');
  });
});

describe('volumeStatusLine', () => {
  const idle = { computing: false, live: false, stale: false };
  it('reads one plain line per state', () => {
    expect(volumeStatusLine(undefined, idle)).toEqual({ tone: 'muted', text: 'Not computed yet' });
    expect(volumeStatusLine(undefined, { ...idle, computing: true }).text).toBe('Computing');
    expect(volumeStatusLine(result(), idle)).toEqual({ tone: 'ok', text: 'Up to date' });
    expect(volumeStatusLine(result(), { ...idle, stale: true })).toEqual({
      tone: 'warn',
      text: 'Stale, recompute',
    });
    expect(volumeStatusLine(result({ status: 'partial' }), idle)).toEqual({
      tone: 'warn',
      text: 'Partly outside the survey',
    });
    expect(volumeStatusLine(result({ status: 'partial', reason: '23% outside' }), idle).text).toBe(
      'Partly outside the survey: 23% outside',
    );
    expect(volumeStatusLine(result({ status: 'refused' }), idle).text).toBe(
      'Not computed: the survey does not cover it',
    );
    expect(
      volumeStatusLine(result({ status: 'refused', reason: 'no survey under it' }), idle).text,
    ).toBe('Not computed: no survey under it');
    expect(volumeStatusLine(result(), { ...idle, live: true }).text).toBe(
      'Live while you edit; saved when the edit ends.',
    );
    const carried = result({ carried: { from: 'kit', base: 'plane', pile: 'p', epoch: 'e' } });
    // a carried figure is never stale
    expect(volumeStatusLine(carried, { ...idle, stale: true })).toEqual({
      tone: 'muted',
      text: 'From an earlier version (kit, Best-fit plane)',
    });
  });
});
