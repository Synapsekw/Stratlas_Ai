// @vitest-environment jsdom
import {
  defaultSurveySettings,
  type ComparisonResult,
  type SurveyMeasurement,
  type SurveySettings,
} from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceState } from '../surfaceStates';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const s = vi.hoisted(() => ({
  compare: Object.create(null) as Record<string, unknown>,
  measure: {} as {
    settings: SurveySettings;
    readOnly: boolean;
    kitDensity: null;
    file: { measurements: SurveyMeasurement[] };
  },
  dates: [] as { capture: string; label: string; date: string; state: SurfaceState }[],
}));
const calls = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  saveSettings: vi.fn<(s: SurveySettings) => Promise<string | null>>(() => Promise.resolve(null)),
}));

vi.mock('../compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel(s.compare),
  isStale: () => false,
  seriesStale: () => false,
  compute: vi.fn(() => Promise.resolve(null)),
  prepareSurfaces: vi.fn(),
  prepareParams: vi.fn(),
  recomputeStandard: vi.fn(),
  computeSeries: vi.fn(() => Promise.resolve(false)),
  useSpread: () => null,
  setHeat: vi.fn(),
}));
vi.mock('../measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  select: calls.select,
  updateMeasurement: calls.update,
  saveSiteSettings: calls.saveSettings,
}));
vi.mock('../card/slots', () => ({ useSurveyDates: () => s.dates }));
vi.mock('../card/BasePicker', () => ({
  BasePicker: () => <div data-testid="base-picker">Triangulated toe</div>,
  DEFAULT_BASE: { kind: 'smart' },
}));
// the tabs other than Overview have their own tests
vi.mock('./PileProfile', () => ({ PileProfile: () => <div data-testid="pile-profile" /> }));
vi.mock('./PileHistory', () => ({ PileHistory: () => <div data-testid="pile-history" /> }));
vi.mock('../Calculators', () => ({
  Calculators: () => <div data-testid="survey-calculators">Loose Compacted Weighed tonnage</div>,
}));
vi.mock('../Comparison', () => ({ HeatControls: () => <fieldset data-testid="survey-heat" /> }));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => false }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { id: 'p1', manifest: { captures: [], layers: [] } } }),
}));

const { PilePanel } = await import('./PilePanel');
const { pileView } = await import('./pileView');
const { takeVolumesPick } = await import('../volumesPick');

const NOW = '2026-10-24T00:00:00.000Z';
const CAPTURES = [
  { id: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
  { id: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
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

function pile(id: string, over: Partial<SurveyMeasurement> = {}): SurveyMeasurement {
  return {
    id,
    family: 'polygon',
    tool: 'volume',
    label: `Pile ${id}`,
    scope: { kind: 'site' },
    points: [
      [0, 0, 10],
      [40, 0, 10],
      [40, 20, 10],
      [0, 20, 10],
    ],
    items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    results: [result(11378.7, 'c2')],
    series: [result(14686.7, 'c1')],
    material: 'agg',
    createdAt: NOW,
    ...over,
  };
}

const settings: SurveySettings = {
  ...defaultSurveySettings(),
  materials: [{ id: 'agg', name: 'Aggregate 20 mm', densityTPerM3: 1.6 }] as never,
};

let host: HTMLDivElement;
let root: Root | undefined;
const render = (id = '02', order: string[] = ['01', '02', '03']) => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<PilePanel id={id} order={order} />);
  });
};
const q = (sel: string) => host.querySelector(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';
const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('not found');
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  pileView.setState({ tab: 'overview', axis: new Map(), historyUnit: 'm3' });
  s.compare = {
    status: 'ready',
    captures: CAPTURES,
    current: {},
    surfaces: [],
    designs: [],
    computed: {},
    running: {},
    problems: {},
    preparing: null,
    error: null,
  };
  s.measure = {
    settings,
    readOnly: false,
    kitDensity: null,
    file: { measurements: [pile('01'), pile('02'), pile('03')] },
  };
  s.dates = [
    { capture: 'c1', label: '31 Dec 2020', date: '2020-12-31', state: { kind: 'ready' } },
    { capture: 'c2', label: '10 Jan 2021', date: '2021-01-10', state: { kind: 'ready' } },
  ];
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('PilePanel', () => {
  it('the panel shows name, material, density, Volume, Tonnes and vs previous', () => {
    render();
    expect(q('[data-testid="pile-panel"]')?.getAttribute('data-id')).toBe('02');
    expect(text('[data-testid="pile-name"]')).toBe('Pile 02');
    const material = q('[data-testid="pile-material"]') as HTMLSelectElement;
    expect(material.value).toBe('agg');
    expect(material.selectedOptions[0]?.textContent).toBe('Aggregate 20 mm');
    expect((q('[data-testid="pile-density"]') as HTMLInputElement).value).toBe('1.60');
    expect(text('[data-testid="pile-kpi-volume"]')).toContain('11 378.7');
    expect(text('[data-testid="pile-kpi-volume"]')).toContain('10 Jan 2021');
    expect(text('[data-testid="pile-kpi-tonnes"]')).toContain('18 206');
    expect(text('[data-testid="pile-kpi-tonnes"]')).toContain('at 1.60 t/m³');
    const vs = q('[data-testid="pile-kpi-vs"]');
    expect(vs?.textContent).toContain('vs 31 Dec 2020');
    expect(vs?.textContent).toContain('−3 308.0');
    expect(vs?.textContent).toContain('−22.5 %');
    expect(vs?.getAttribute('data-sign')).toBe('loss');
    // facts: footprint of the ring, the base picker
    expect(text('[data-testid="pile-footprint"]')).toContain('800');
    expect(q('[data-testid="pile-facts"] [data-testid="base-picker"]')).not.toBeNull();
    // an up-to-date figure has no status line under the tiles
    expect(q('[data-testid="pile-status"]')).toBeNull();
  });

  it('vs reads "first survey" with one date and "preparing 62 %" while the earlier surface prepares', () => {
    s.measure.file.measurements = [pile('02', { series: [] })];
    render('02', ['02']);
    expect(text('[data-testid="pile-kpi-vs"]')).toContain('first survey');
    s.dates = [
      {
        capture: 'c1',
        label: '31 Dec 2020',
        date: '2020-12-31',
        state: { kind: 'preparing', pct: 62 },
      },
      { capture: 'c2', label: '10 Jan 2021', date: '2021-01-10', state: { kind: 'ready' } },
    ];
    render('02', ['02']);
    expect(text('[data-testid="pile-kpi-vs"]')).toContain('vs 31 Dec 2020');
    expect(text('[data-testid="pile-kpi-vs"]')).toContain('preparing 62 %');
  });

  it('a carried result shows its status line', () => {
    s.measure.file.measurements = [
      pile('02', {
        origin: { kind: 'kit-pile', pile: 'k2' },
        results: [
          result(11378.7, 'c2', {
            carried: { from: 'kit', base: 'toe', pile: 'k2', epoch: '2021-01-10' },
          }),
        ],
      }),
    ];
    render('02', ['02']);
    const status = q('[data-testid="pile-status"]');
    expect(status?.textContent).toContain('From an earlier version (kit');
    // the figure shows with it, never without
    expect(text('[data-testid="pile-kpi-volume"]')).toContain('11 378.7');
  });

  it('‹ Inventory returns and Pile 2 of 19 steps', () => {
    const order = Array.from({ length: 19 }, (_, i) => String(i + 1).padStart(2, '0'));
    s.measure.file.measurements = order.map((id) => pile(id));
    render('02', order);
    expect(text('[data-testid="pile-position"]')).toBe('Pile 2 of 19');
    click(q('[data-testid="pile-next"]'));
    expect(calls.select).toHaveBeenLastCalledWith(['03'], '03');
    // the step is the view's own pick: the Measure tab does not follow it
    expect(takeVolumesPick('03')).toBe(true);
    click(q('[data-testid="pile-prev"]'));
    expect(calls.select).toHaveBeenLastCalledWith(['01'], '01');
    click(q('[data-testid="pile-back"]'));
    expect(calls.select).toHaveBeenLastCalledWith([], null);
    expect(text('[data-testid="pile-back"]')).toBe('‹ Inventory');
  });

  it('Esc in the panel returns to the inventory', () => {
    render();
    const panel = q('[data-testid="pile-panel"]');
    act(() => {
      panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(calls.select).toHaveBeenLastCalledWith([], null);
  });

  it('More holds heat map, swell and weighed tonnage', () => {
    render();
    expect(q('[data-testid="pile-overview"]')).not.toBeNull();
    const more = q('[data-testid="pile-more"]') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.querySelector('summary')?.textContent).toBe('More');
    expect(more.querySelector('[data-testid="survey-heat"]')).not.toBeNull();
    expect(more.querySelector('[data-testid="survey-calculators"]')).not.toBeNull();
    // the cut and fill split of the figure
    expect(text('[data-testid="pile-split"]')).toContain('11 378.7');
  });

  it('switches to Profile and History', () => {
    render();
    click(q('[role="tab"][id$="-tab-profile"]'));
    expect(q('[data-testid="pile-profile"]')).not.toBeNull();
    click(q('[role="tab"][id$="-tab-history"]'));
    expect(q('[data-testid="pile-history"]')).not.toBeNull();
  });

  it('density edit writes the material', async () => {
    render();
    const input = q('[data-testid="pile-density"]') as HTMLInputElement;
    act(() => {
      // React reads the native setter's value, not one set on the element
      Reflect.set(HTMLInputElement.prototype, 'value', '1.75', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    expect(calls.saveSettings).toHaveBeenCalledTimes(1);
    const saved = calls.saveSettings.mock.calls[0]?.[0];
    expect(saved?.materials).toEqual([{ id: 'agg', name: 'Aggregate 20 mm', densityTPerM3: 1.75 }]);
  });

  it('without a material the density is disabled with why, and the chip offers the materials', () => {
    s.measure.file.measurements = [pile('02', { material: undefined })];
    render('02', ['02']);
    const input = q('[data-testid="pile-density"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(text('[data-testid="pile-density-why"]')).toBe('Pick a material first');
    expect(text('[data-testid="pile-kpi-tonnes"]')).not.toContain('t/m³');
    const material = q('[data-testid="pile-material"]') as HTMLSelectElement;
    expect([...material.options].map((o) => o.textContent)).toEqual([
      'No material',
      'Aggregate 20 mm',
    ]);
    act(() => {
      material.value = 'agg';
      material.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(calls.update).toHaveBeenCalledTimes(1);
    const fn = calls.update.mock.calls[0]?.[1] as (m: SurveyMeasurement) => SurveyMeasurement;
    expect(fn(pile('02', { material: undefined })).material).toBe('agg');
  });
});
