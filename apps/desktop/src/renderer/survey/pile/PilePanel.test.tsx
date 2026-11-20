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
import { linkedHover } from '../linkedHover';

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
  surveys: [] as { id: string; date: string; label: string }[],
  focus: null as string | null,
  /** The focused measurement (`measureStore`), as the panel reads it when it closes. */
  picked: null as string | null,
}));
const calls = vi.hoisted(() => ({
  select: vi.fn(),
  showBench: vi.fn(),
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
  measureStore: { getState: () => ({ focus: s.picked }) },
  select: calls.select,
  updateMeasurement: calls.update,
  saveSiteSettings: calls.saveSettings,
}));
vi.mock('../../workspace/workbench/followTool', () => ({ showBench: calls.showBench }));
vi.mock('../card/slots', () => ({ useSurveyDates: () => s.dates }));
vi.mock('../surfaceStates', () => ({ usePrepareRunning: () => false }));
// the card's "⋯" menu has its own tests (the registry's actions)
vi.mock('../card/CardActions', () => ({
  CardMenu: ({ id }: { id: string }) => (
    <button type="button" data-testid="card-menu" data-id={id} aria-label={`Actions for ${id}`} />
  ),
}));
vi.mock('../card/BasePicker', () => ({
  BasePicker: () => <div data-testid="base-picker">Triangulated toe</div>,
  DEFAULT_BASE: { kind: 'smart' },
}));
// the tabs other than Overview have their own tests
vi.mock('./pileAxisScene', () => ({ stagePile: () => null }));
// each with its first row, as the real ones mark it (`data-pile-lead`)
vi.mock('./PileProfile', () => ({
  PileProfile: () => (
    <div data-testid="pile-profile">
      <div data-pile-lead="" data-testid="profile-lead" />
    </div>
  ),
}));
vi.mock('./PileHistory', () => ({
  PileHistory: () => (
    <div data-testid="pile-history">
      <div data-pile-lead="" data-testid="history-lead" />
    </div>
  ),
}));
vi.mock('../Calculators', () => ({
  Calculators: () => <div data-testid="survey-calculators">Loose Compacted Weighed tonnage</div>,
}));
vi.mock('../Comparison', () => ({ HeatControls: () => <fieldset data-testid="survey-heat" /> }));
// the card's over-time gap reasons read the surface states, whose store pulls in the shell
vi.mock('../surfaceStates', () => ({
  useSurfaceStates: () => new Map(),
  usePreparingSoon: () => false,
}));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => false }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { id: 'p1', manifest: { captures: s.surveys, layers: [] } } }),
}));
vi.mock('../../workspace/timeline', () => ({
  useTimeline: (sel: (x: unknown) => unknown) => sel({ focus: s.focus }),
}));

const { PilePanel } = await import('./PilePanel');
const { pileView } = await import('./pileView');
const { openedFromInventory, pileOrigin } = await import('./pileOrigin');
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
/** `order` null: the panel as Selection mounts it, with no order of its own. */
const render = (id = '02', order: string[] | null = ['01', '02', '03']) => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<PilePanel id={id} {...(order ? { order } : {})} />);
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
  s.surveys = [];
  s.focus = null;
  s.picked = null;
  pileOrigin.setState({ id: null, order: null });
  pileView.setState({ tab: 'overview', axis: new Map(), fitted: new Map(), historyUnit: 'm3' });
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

  it('Pile 2 of 19 steps', () => {
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
  });

  it('opened from 3D, the Map or the sidebar it says "Back to inventory" too, which closes the pile and shows Project > Volumes', () => {
    // no note of an open from the inventory: the route every other open leaves
    render('02', null);
    expect(text('[data-testid="pile-back"]')).toBe('Back to inventory');
    // the arrows still step through every pile, in the file's order
    expect(text('[data-testid="pile-position"]')).toBe('Pile 2 of 3');
    click(q('[data-testid="pile-back"]'));
    expect(calls.select).toHaveBeenLastCalledWith([], null);
    expect(calls.showBench).toHaveBeenLastCalledWith('volumes');
  });

  it('opened from the inventory it says "Back to inventory", which returns to Project > Volumes', () => {
    openedFromInventory('02', ['03', '02', '01']);
    s.picked = '02';
    render('02', null);
    expect(text('[data-testid="pile-back"]')).toBe('Back to inventory');
    // the arrows follow the inventory's order, not the file's
    expect(text('[data-testid="pile-position"]')).toBe('Pile 2 of 3');
    click(q('[data-testid="pile-next"]'));
    expect(calls.select).toHaveBeenLastCalledWith(['01'], '01');
    // the selection follows (the store is a stub here): the next pile's panel keeps the link
    s.picked = '01';
    render('01', null);
    click(q('[data-testid="pile-back"]'));
    expect(calls.select).toHaveBeenLastCalledWith([], null);
    expect(calls.showBench).toHaveBeenLastCalledWith('volumes');
    expect(pileOrigin.getState().id).toBeNull();
  });

  it("a step with the arrows keeps the inventory's order; a pile opened another way drops it and keeps the link", () => {
    openedFromInventory('02', ['01', '02', '03']);
    s.picked = '02';
    render('02', null);
    click(q('[data-testid="pile-next"]'));
    expect(pileOrigin.getState()).toEqual({ id: '03', order: ['01', '02', '03'] });
    s.picked = '03';
    render('03', null);
    expect(text('[data-testid="pile-back"]')).toBe('Back to inventory');
    // another pile is clicked in 3D: no note for it, and the old one is dropped
    s.picked = '01';
    render('01', null);
    expect(text('[data-testid="pile-back"]')).toBe('Back to inventory');
    expect(pileOrigin.getState().id).toBeNull();
  });

  it('closing the pile forgets where it came from; a change of tab does not', () => {
    openedFromInventory('02');
    s.picked = '02';
    render('02', null);
    // the Selection tab is left with the pile still open: the panel unmounts, the note stays
    act(() => root?.unmount());
    root = undefined;
    expect(pileOrigin.getState().id).toBe('02');
    render('02', null);
    expect(q('[data-testid="pile-back"]')).not.toBeNull();
    // the pile is closed (Esc, a click on empty ground): the note goes with it
    s.picked = null;
    act(() => root?.unmount());
    root = undefined;
    expect(pileOrigin.getState().id).toBeNull();
  });

  it('Esc in the panel closes the pile, without leaving Selection', () => {
    render();
    const panel = q('[data-testid="pile-panel"]');
    act(() => {
      panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(calls.select).toHaveBeenLastCalledWith([], null);
    expect(calls.showBench).not.toHaveBeenCalled();
  });

  it('Esc in the panel clears a pinned point first, then closes the pile', () => {
    render();
    linkedHover.setState({
      lines: new Map([['pile:02', { key: 'pile:02', polyline: [], series: [] }]]),
      pin: { key: 'pile:02', chainageM: 4, source: 'chart' },
    });
    calls.select.mockClear();
    const panel = q('[data-testid="pile-panel"]');
    const esc = () => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => {
        panel?.dispatchEvent(e);
      });
      return e;
    };
    expect(esc().defaultPrevented).toBe(true);
    expect(linkedHover.getState().pin).toBeNull();
    expect(calls.select).not.toHaveBeenCalled();
    expect(esc().defaultPrevented).toBe(true);
    expect(calls.select).toHaveBeenLastCalledWith([], null);
    linkedHover.setState({ lines: new Map(), pin: null });
  });

  it("names the base by the picker's name, not the engine's stored words", () => {
    render();
    // the result's stored label is 'Triangulated toe'; the item's base is the Toe surface
    const method = text('.pp-method');
    expect(method).toContain('Toe surface');
    expect(method).not.toContain('Triangulated');
    s.measure.file.measurements = [
      pile('02', {
        items: [
          {
            id: 'a',
            from: { kind: 'reference', mode: 'level', levelM: 12.5 },
            to: { kind: 'current' },
            useDeadband: false,
          },
        ],
        results: [result(100, 'c2', { fromLabel: 'Reference level 12.50 m' })],
      }),
    ];
    render();
    expect(text('.pp-method')).toContain('Fixed level');
    expect(text('.pp-method')).not.toContain('Reference level');
  });

  it('keeps the level beside the name of a base that is one level', () => {
    const on = (from: SurveyMeasurement['items'][number]['from'], fromLabel: string) => {
      s.measure.file.measurements = [
        pile('02', {
          items: [{ id: 'a', from, to: { kind: 'current' }, useDeadband: false }],
          results: [result(100, 'c2', { fromLabel })],
        }),
      ];
      render();
      return text('.pp-method');
    };
    // the level the figure was computed on, as the engine stored it, in the panel's units
    expect(on({ kind: 'reference', mode: 'level', levelM: 12.5 }, 'Level 12.500 m')).toMatch(
      /Fixed level \(12\.50* m\)/,
    );
    expect(
      on({ kind: 'reference', mode: 'perimeter-min' }, 'Lowest point on the perimeter (38.250 m)'),
    ).toMatch(/Lowest point \(38\.250* m\)/);
    expect(on({ kind: 'perimeter-mean' }, 'Mean perimeter level (39.750 m)')).toMatch(
      /Average edge level \(39\.750* m\)/,
    );
    // a base that is no single level has none
    expect(on({ kind: 'smart' }, 'Triangulated toe')).not.toMatch(/Toe surface \(/);
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

  describe('a tab just picked brings its first row into view', () => {
    // jsdom lays nothing out: the call is what the panel owes
    const shown: string[] = [];
    const into = vi.fn(function (this: HTMLElement, opts?: ScrollIntoViewOptions) {
      shown.push(`${this.getAttribute('data-testid') ?? ''}:${opts?.block ?? ''}`);
    });
    beforeEach(() => {
      shown.length = 0;
      HTMLElement.prototype.scrollIntoView = into;
    });
    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    });

    it('Profile, then History: each by the least scroll that shows it', () => {
      render();
      expect(shown).toEqual([]);
      click(q('[role="tab"][id$="-tab-profile"]'));
      expect(shown).toEqual(['profile-lead:nearest']);
      click(q('[role="tab"][id$="-tab-history"]'));
      expect(shown).toEqual(['profile-lead:nearest', 'history-lead:nearest']);
      // Overview has no such row: the panel stays where it is
      click(q('[role="tab"][id$="-tab-overview"]'));
      expect(shown).toHaveLength(2);
    });

    it('a pile opened on the tab it was left on does not move the panel', () => {
      pileView.setState({ tab: 'profile' });
      render();
      expect(q('[data-testid="profile-lead"]')).not.toBeNull();
      render('03');
      expect(shown).toEqual([]);
    });
  });

  it('the head carries the measurement "⋯" menu (rename, colour, fly to, …)', () => {
    render();
    const menu = q('.pp-head [data-testid="card-menu"]');
    expect(menu?.getAttribute('data-id')).toBe('02');
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

  it('density reads and writes are dated (review finding 2)', async () => {
    s.surveys = CAPTURES;
    s.focus = 'c1';
    s.measure.settings = {
      ...settings,
      materials: [
        {
          id: 'agg',
          name: 'Aggregate 20 mm',
          densityTPerM3: 1.6,
          densityHistory: [
            { fromCapture: 'c1', tPerM3: 1.5 },
            { fromCapture: 'c2', tPerM3: 1.6 },
          ],
        },
      ] as never,
    };
    render();
    const input = q('[data-testid="pile-density"]') as HTMLInputElement;
    // the field reads the density on the date in focus, the tonnes tile on the figure's date
    expect(input.value).toBe('1.50');
    expect(text('[data-testid="pile-kpi-tonnes"]')).toContain('at 1.60 t/m³');
    act(() => {
      Reflect.set(HTMLInputElement.prototype, 'value', '1.55', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    const saved = calls.saveSettings.mock.calls[0]?.[0];
    expect(saved?.materials).toEqual([
      {
        id: 'agg',
        name: 'Aggregate 20 mm',
        densityTPerM3: 1.6,
        densityHistory: [
          { fromCapture: 'c1', tPerM3: 1.55 },
          { fromCapture: 'c2', tPerM3: 1.6 },
        ],
      },
    ]);
  });

  it('a first density edit from a later date keeps the earlier dates at the old density', async () => {
    s.surveys = CAPTURES;
    s.focus = 'c2';
    render();
    const input = q('[data-testid="pile-density"]') as HTMLInputElement;
    act(() => {
      Reflect.set(HTMLInputElement.prototype, 'value', '1.75', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    const saved = calls.saveSettings.mock.calls[0]?.[0];
    expect(saved?.materials).toEqual([
      {
        id: 'agg',
        name: 'Aggregate 20 mm',
        densityTPerM3: 1.75,
        densityHistory: [
          { fromCapture: 'c1', tPerM3: 1.6 },
          { fromCapture: 'c2', tPerM3: 1.75 },
        ],
      },
    ]);
  });

  it('the density field writes and reads numbers in the locale', async () => {
    s.measure.settings = {
      ...settings,
      locale: 'imperial',
      materials: [{ id: 'agg', name: 'Aggregate 20 mm', densityTPerM3: 1234.5 }] as never,
    };
    render();
    const input = q('[data-testid="pile-density"]') as HTMLInputElement;
    expect(input.value).toBe('1,234.50');
    expect(text('[data-testid="pile-kpi-tonnes"]')).toContain('at 1,234.50 t/m³');
    act(() => {
      Reflect.set(HTMLInputElement.prototype, 'value', '1,500.25', input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });
    const saved = calls.saveSettings.mock.calls[0]?.[0];
    expect(saved?.materials).toEqual([
      { id: 'agg', name: 'Aggregate 20 mm', densityTPerM3: 1500.25 },
    ]);
  });

  it('a pile line kept for the pile is fitted again when its outline is edited', () => {
    render();
    const turned = { a: [0, 0], b: [1, 1], centre: [0.5, 0.5], angleDeg: 30, lengthM: 1.4 };
    act(() => {
      pileView.getState().setAxis('02', turned as never);
    });
    expect(pileView.getState().axis.get('02')).toBe(turned);
    s.measure = {
      ...s.measure,
      file: {
        measurements: s.measure.file.measurements.map((x) =>
          x.id === '02'
            ? {
                ...x,
                points: [
                  [100, 0, 10],
                  [180, 0, 10],
                  [180, 20, 10],
                  [100, 20, 10],
                ],
              }
            : x,
        ),
      },
    };
    render();
    const now = pileView.getState().axis.get('02');
    expect(now).not.toBe(turned);
    expect(now?.angleDeg).toBeCloseTo(30, 6);
    expect(now?.centre[0]).toBeCloseTo(140, 6);
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
