// @vitest-environment jsdom
import { formatQuantity } from '@aio/geo';
import {
  defaultSurveySettings,
  type ComparisonResult,
  type HeightTiles,
  type SurveyMeasurement,
  type SurveySettings,
} from '@aio/schema';
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
}));
const calls = vi.hoisted(() => ({
  compute: vi.fn(() => Promise.resolve(null)),
  computeSeries: vi.fn(() => Promise.resolve(false)),
  recomputeStandard: vi.fn(() => Promise.resolve(null as string | null)),
  prepareSurfaces: vi.fn(() => Promise.resolve(null)),
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
}));
vi.mock('../measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  updateMeasurement: calls.updateMeasurement,
}));
vi.mock('../BaseEditor', () => ({ BaseEditor: () => <div data-testid="base-editor" /> }));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => false }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { manifest: { captures: [], layers: [] } } }),
}));

const { VolumeDetail, volumeStatusLine } = await import('./VolumeDetail');

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

beforeEach(() => {
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
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('From an earlier version (kit tin)');
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
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('From an earlier version (kit tin)');
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
    expect(text).toContain('No survey data');
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

  it('over-time table shows change and tonnage', () => {
    const series = [
      result({ toCapture: 'c1', netM3: 3070, totalM3: 3070, fingerprint: 'f1' }),
      result({ toCapture: 'c2', netM3: 3482, totalM3: 3482, fingerprint: 'f2' }),
    ];
    show(pile({ material: 'mat1', series }));
    const table = host.querySelector('[data-testid="vol-time-table"]');
    expect(
      [...(table?.querySelectorAll('th[scope="col"]') ?? [])].map((x) => x.textContent),
    ).toEqual(['Date', 'Volume', 'Change', 'Tonnage']);
    const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
    expect(rows).toHaveLength(2);
    const latest = rows[1];
    expect(latest?.hasAttribute('data-latest')).toBe(true);
    expect(rows[0]?.hasAttribute('data-latest')).toBe(false);
    const cells = [...(latest?.querySelectorAll('td') ?? [])].map((c) => c.textContent);
    expect(cells[0]).toBe(v(3482));
    expect(cells[1]).toBe(`+${v(412)}`);
    expect(cells[2]).toBe(
      formatQuantity(3482 * 1.7, 'mass', settings().units, settings().precision),
    );
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
    expect(heads.map((x) => x.textContent)).toEqual(['Date', 'Volume', 'Change']);
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
    expect(rows.map((r) => r.querySelector('td')?.textContent)).toEqual([v(-20), v(-35)]);
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
    expect(byTestId('survey-cmp-status')[0]?.textContent).toBe('No survey data');
    const rows = [...host.querySelectorAll('[data-testid="vol-time-table"] tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[1]?.querySelector('td')?.textContent).toBe('No survey data');
  });

  it('spread hint formats ±1.8 % across bases', () => {
    s.spread = { pct: 1.8, nets: [] };
    show(pile());
    expect(byTestId('vol-spread')[0]?.textContent).toBe('±1.8 % across bases');

    // a fixed level is not one of the spread bases: no hint
    act(() => root?.unmount());
    host.remove();
    show(
      pile({
        items: [
          {
            id: 'a',
            from: { kind: 'reference', mode: 'level', levelM: 9 },
            to: { kind: 'current' },
            useDeadband: false,
          },
        ],
      }),
    );
    expect(byTestId('vol-spread')).toHaveLength(0);
  });

  it('shows the prepare empty state when no surface is prepared', () => {
    s.compare.surfaces = [];
    show(pile({ results: [] }));
    expect(host.textContent).toContain('No survey surface is prepared yet');
    click(byTestId('survey-prepare')[0]);
    expect(calls.prepareSurfaces).toHaveBeenCalledTimes(1);
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
    expect(volumeStatusLine(result({ status: 'partial' }), idle).tone).toBe('warn');
    expect(volumeStatusLine(result({ status: 'refused' }), idle).text).toBe(
      'Not computed: the survey does not cover it',
    );
    expect(volumeStatusLine(result(), { ...idle, live: true }).text).toBe(
      'Live while you edit; saved when the edit ends.',
    );
    const carried = result({ carried: { from: 'kit', base: 'plane', pile: 'p', epoch: 'e' } });
    // a carried figure is never stale
    expect(volumeStatusLine(carried, { ...idle, stale: true })).toEqual({
      tone: 'muted',
      text: 'From an earlier version (kit plane)',
    });
  });
});
