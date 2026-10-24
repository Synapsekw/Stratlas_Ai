// @vitest-environment jsdom
import { defaultSurveySettings, type SiteMaterial } from '@aio/schema';
import type { MaterialGroup } from '@aio/survey';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../survey/compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel({ surfaces: [], status: 'ready' }),
  engineClient: () => ({ run: vi.fn(), site: vi.fn() }),
}));

const { DatesStripView } = await import('./DatesStrip');
type Props = Parameters<typeof DatesStripView>[0];
type Day = Props['days'][number];

const AGG: SiteMaterial = { id: 'agg', name: 'Aggregate 20 mm', densityTPerM3: 1.6 };
const SAND: SiteMaterial = { id: 'sand', name: 'Washed sand' };

const group = (material: SiteMaterial | null, volumeM3: number, tonnes: number | null) =>
  ({
    material,
    colour: material ? `var(--mat-${material.id})` : 'var(--mat-none)',
    volumeM3,
    tonnes,
    deltaM3: null,
    piles: [
      { id: `p-${material?.id ?? 'none'}`, label: 'Pile 02', volumeM3, tonnes, deltaM3: null },
    ],
  }) as MaterialGroup;

function day(capture: string, date: string, agg: number, sand: number, density = 1.6): Day {
  const groups = [group(AGG, agg, agg * density), group(SAND, sand, null)];
  return {
    capture,
    t: Date.parse(date),
    label: `${date} long`,
    short: `${date} short`,
    colour: 'var(--date-1)',
    groups,
    volumeM3: agg + sand,
    tonnes: agg * density,
    piles: new Map([
      ['p-agg', { volumeM3: agg, tonnes: agg * density }],
      ['p-sand', { volumeM3: sand, tonnes: null }],
    ]),
  };
}

const DAYS = [
  day('c1', '2020-12-31', 60000, 16000),
  day('c2', '2021-01-10', 50000, 13000),
  day('c3', '2021-03-02', 40000, 12000),
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let props: Props;

function base(): Props {
  return {
    days: DAYS,
    focus: 'c2',
    mode: 'volume',
    onMode: vi.fn(),
    units: defaultSurveySettings().units,
    locale: 'metric',
    preview: false,
    pile: null,
    onClearPile: vi.fn(),
    compare: { on: false, from: null, to: null },
    onCompareToggle: vi.fn(),
    onCompareSet: vi.fn(),
    player: { playing: false, speed: 1, loop: false, t: null, passed: null },
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSpeed: vi.fn(),
    onLoop: vi.fn(),
    onFocus: vi.fn(),
    collapsed: false,
    onCollapse: vi.fn(),
    width: 800,
  };
}

function render(over: Partial<Props> = {}): HTMLDivElement {
  props = { ...base(), ...over };
  if (!host) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root?.render(<DatesStripView {...props} />));
  return host;
}

const q = (sel: string): HTMLElement => {
  const el = host?.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
const all = (sel: string) => [...(host?.querySelectorAll<HTMLElement>(sel) ?? [])];
const button = (name: string): HTMLButtonElement => {
  const b = all('button').find(
    (x) => x.getAttribute('aria-label') === name || x.textContent === name,
  );
  if (!b) throw new Error(`no button ${name}`);
  return b as HTMLButtonElement;
};

/** jsdom has no PointerEvent: a MouseEvent of the pointer type with an id. */
function pointer(el: Element, type: string, clientX: number) {
  const e = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  act(() => {
    el.dispatchEvent(e);
  });
}

/** The x a time takes on the 800 px test chart (52 px axis on the left, 16 px on the right). */
function xOf(date: string): number {
  const ts = DAYS.map((d) => d.t);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const pad = (t1 - t0) * 0.04;
  return 52 + ((Date.parse(date) - (t0 - pad)) / (t1 - t0 + 2 * pad)) * (800 - 52 - 16);
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('DatesStripView', () => {
  it('is the "Survey dates chart" region, never "Timeline"', () => {
    render();
    const region = q('[role="region"]');
    expect(region.getAttribute('aria-label')).toBe('Survey dates chart');
    expect(host?.querySelector('[aria-label="Timeline"]')).toBeNull();
  });

  it('the strip draws a marker per survey and month gridlines', () => {
    render();
    expect(all('[data-survey]').map((m) => m.dataset.survey)).toEqual(['c1', 'c2', 'c3']);
    expect(q('[data-survey="c2"]').getAttribute('aria-current')).toBe('date');
    const months = all('[data-month]').map((g) => g.dataset.month);
    expect(months).toEqual(['Jan 2021', 'Feb 2021', 'Mar 2021']);
    // the stack by material, one group per material
    expect(all('g[data-stack]').map((g) => g.dataset.stack)).toEqual(['agg', 'sand']);
    expect(q('[data-testid="strip-legend"]').textContent).toBe('Aggregate 20 mmWashed sand');
    expect(q('.pc-axis-title').textContent).toBe('Volume (m³)');
    expect(all('.pc-grid[data-axis="y"] text').map((x) => x.textContent)).toEqual([
      '0',
      '40k',
      '80k',
    ]);
  });

  it('a click on a marker jumps to its survey', () => {
    render();
    act(() => {
      q('[data-survey="c3"]').click();
    });
    expect(props.onFocus).toHaveBeenCalledWith('c3');
  });

  it('dragging the playhead focuses the nearest survey', () => {
    render();
    const ph = q('[data-testid="strip-playhead"]');
    expect(ph.getAttribute('aria-valuetext')).toBe('2021-01-10 long');
    pointer(ph, 'pointerdown', xOf('2021-01-10'));
    pointer(ph, 'pointermove', xOf('2021-02-25'));
    expect(props.onFocus).toHaveBeenLastCalledWith('c3');
    pointer(ph, 'pointermove', xOf('2021-01-02'));
    expect(props.onFocus).toHaveBeenLastCalledWith('c1');
    pointer(ph, 'pointerup', xOf('2021-01-02'));
    expect(props.onFocus).toHaveBeenCalledTimes(2);
  });

  it('the readout follows a drag, not the survey hovered before it', () => {
    render();
    const ph = q('[data-testid="strip-playhead"]');
    // the pointer comes over the plot onto the playhead: the hovered survey reads out
    const head = () => q('[data-testid="strip-readout"] .pc-ro-head').textContent;
    pointer(q('[data-testid="strip-chart"]'), 'pointermove', xOf('2020-12-31'));
    expect(head()).toBe('2020-12-31 long');
    pointer(ph, 'pointerdown', xOf('2021-01-10'));
    pointer(ph, 'pointermove', xOf('2021-02-25'));
    expect(head()).toBe('2021-03-02 long');
  });

  it('the arrow keys step the playhead through the surveys', () => {
    render();
    const ph = q('[data-testid="strip-playhead"]');
    act(() => {
      ph.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(props.onFocus).toHaveBeenLastCalledWith('c3');
    act(() => {
      ph.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(props.onFocus).toHaveBeenLastCalledWith('c1');
  });

  it('shows the readout of the date in focus with its change', () => {
    render();
    const ro = q('[data-testid="strip-readout"]');
    expect(ro.querySelector('.pc-ro-head')?.textContent).toBe('2021-01-10 long');
    expect(ro.textContent).toContain('63 000 m³ · 80 000 t');
    expect(ro.textContent).toContain('Δ −13 000 m³ · −17.1 %');
    expect(ro.textContent).toContain('vs 2020-12-31 long');
  });

  it('Compare draws the band with its label and brackets move it', () => {
    render({ compare: { on: true, from: 'c1', to: 'c2' } });
    expect(button('Compare').getAttribute('aria-pressed')).toBe('true');
    expect(host?.querySelector('[data-testid="strip-band"]')).not.toBeNull();
    expect(q('[data-testid="strip-band-label"]').textContent).toBe(
      '2020-12-31 short → 2021-01-10 short · −13 000 m³',
    );
    const to = q('[data-testid="strip-bracket-to"]');
    expect(to.getAttribute('aria-label')).toBe('Compare to 2021-01-10 long');
    pointer(to, 'pointerdown', xOf('2021-01-10'));
    pointer(to, 'pointerup', xOf('2021-02-28'));
    expect(props.onCompareSet).toHaveBeenLastCalledWith('c1', 'c3');
    act(() => {
      q('[data-testid="strip-bracket-from"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    // the From bracket never lands on To
    expect(props.onCompareSet).toHaveBeenCalledTimes(1);
  });

  it('fits to the compare range and back to all surveys', () => {
    render({ compare: { on: true, from: 'c1', to: 'c2' } });
    const fit = q('[data-testid="strip-fit"]');
    expect(fit.getAttribute('aria-label')).toBe('Fit to the compare range');
    act(() => {
      fit.click();
    });
    expect(q('[data-testid="strip-fit"]').getAttribute('aria-label')).toBe('Fit to all surveys');
    // the third survey is out of view
    expect(host?.querySelector('[data-survey="c3"]')).toBeNull();
  });

  it('Tonnes uses the draft density and says preview, unsaved', () => {
    const draft = [
      day('c1', '2020-12-31', 60000, 16000, 2),
      day('c2', '2021-01-10', 50000, 13000, 2),
    ];
    render({ days: draft, mode: 'tonnes', preview: true });
    expect(q('[data-testid="strip-preview"]').textContent).toBe('· preview, unsaved');
    expect(q('.pc-axis-title').textContent).toBe('Tonnes (t)');
    expect(q('[data-testid="strip-readout"]').textContent).toContain('63 000 m³ · 100 000 t');
    render({ days: draft, mode: 'volume', preview: true });
    expect(host?.querySelector('[data-testid="strip-preview"]')).toBeNull();
  });

  it('a selected pile shows its line, the faded total and the Pile chip that clears it', () => {
    render({ pile: { id: 'p-agg', label: 'Pile 02', colour: 'var(--mat-1)' } });
    expect(host?.querySelector('g[data-stack]')).toBeNull();
    expect(q('[data-testid="strip-pile-line"]').querySelectorAll('.ds-pile-dot')).toHaveLength(3);
    expect(q('.ds-site-note').textContent).toBe('site total (own scale)');
    expect(q('.ds-faded').textContent).toBe('Site total, faded');
    expect(q('.ds-pile').textContent).toContain('Pile 02');
    expect(q('[data-testid="strip-readout"] .pc-ro-head').textContent).toBe(
      '2021-01-10 long · Pile 02',
    );
    act(() => {
      button('Clear the pile and show the site').click();
    });
    expect(props.onClearPile).toHaveBeenCalled();
  });

  it('a preparing date shows hatched with its percentage', () => {
    const states = new Map([['c1', { kind: 'preparing' as const, pct: 62 }]]);
    const [first, second] = DAYS;
    if (!first || !second) throw new Error('no days');
    const days: Day[] = [
      { ...first, volumeM3: null, tonnes: null, groups: [], piles: new Map() },
      second,
    ];
    render({ days, states });
    expect(q('[data-preparing="c1"]').textContent).toBe('preparing · 62 %');
    expect(q('[data-survey="c1"]').dataset.state).toBe('preparing');
    expect(q('[data-testid="strip-waiting"]').textContent).toBe(
      'Change: waiting for 2020-12-31 short',
    );
  });

  it('Cut & fill draws diverging bars between consecutive surveys', () => {
    render({
      mode: 'cutFill',
      cutFill: {
        bars: [{ from: 'c1', to: 'c2', cutM3: 22598, fillM3: 1227 }],
        waiting: [{ from: 'c2', to: 'c3', on: 'c3' }],
        computing: false,
      },
    });
    const bar = q('[data-bar="c1>c2"]');
    expect(bar.querySelector('.ds-fill')).not.toBeNull();
    expect(bar.querySelector('.ds-cut')).not.toBeNull();
    expect(bar.textContent).toBe('+1 227 fill−22 598 cut');
    expect(host?.querySelector('[data-waiting="c2>c3"]')).not.toBeNull();
    expect(q('.ds-cf-key').textContent).toBe('Fill above zero · Cut below zero · inside piles');
    expect(q('.pc-axis-title').textContent).toBe('Change (m³)');
  });

  it('the bar plays, steps, cycles the speed, loops and switches modes', () => {
    render();
    act(() => {
      button('Play through the survey dates').click();
      button('Previous survey').click();
      button('Playback speed 1×').click();
      button('Loop').click();
      button('Tonnes').click();
    });
    expect(props.onPlay).toHaveBeenCalled();
    expect(props.onFocus).toHaveBeenCalledWith('c1');
    expect(props.onSpeed).toHaveBeenCalledWith(2);
    expect(props.onLoop).toHaveBeenCalled();
    expect(props.onMode).toHaveBeenCalledWith('tonnes');
    render({ player: { playing: true, speed: 4, loop: true, t: DAYS[1]?.t ?? 0, passed: 'c2' } });
    expect(button('Pause').getAttribute('aria-label')).toBe('Pause');
    expect(button('Loop').getAttribute('aria-pressed')).toBe('true');
    act(() => {
      button('Playback speed 4×').click();
    });
    expect(props.onSpeed).toHaveBeenCalledWith(0.5);
  });

  it('writes tonnes in the site mass unit, as the Volumes header does', () => {
    const units = { ...defaultSurveySettings().units, mass: 'kg' as const };
    render({ mode: 'tonnes', units });
    expect(q('.pc-axis-title').textContent).toBe('Tonnes (kg)');
    const ro = q('[data-testid="strip-readout"]').textContent;
    // 50 000 m³ of aggregate at 1.6 t/m³ on 10 Jan: 80 000 t, 80 000 000 kg
    expect(ro).toContain('80 000 000 kg');
    expect(ro).not.toMatch(/\d t\b/);
  });

  it('only the playhead follows the player time while playing', () => {
    let now: number | null = DAYS[0]?.t ?? 0;
    const subs = new Set<() => void>();
    const playhead = {
      get: () => now,
      subscribe: (cb: () => void) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };
    render({ player: { playing: true, speed: 1, loop: false, passed: 'c1' }, playhead });
    const before = q('[data-testid="strip-playhead"]').style.left;
    const readout = q('[data-testid="strip-readout"]').getAttribute('style');
    act(() => {
      now = Date.parse('2021-01-05');
      for (const cb of subs) cb();
    });
    expect(q('[data-testid="strip-playhead"]').style.left).not.toBe(before);
    expect(parseFloat(q('[data-testid="strip-playhead"]').style.left)).toBeCloseTo(
      xOf('2021-01-05'),
      0,
    );
    // the readout stays at the last survey passed
    expect(q('[data-testid="strip-readout"]').getAttribute('style')).toBe(readout);
  });

  it('draws a gap for a date without a counted figure, never a zero', () => {
    const [first, middle, last] = DAYS;
    if (!first || !middle || !last) throw new Error('three days');
    const empty: Day = { ...middle, groups: [], volumeM3: null, tonnes: null, piles: new Map() };
    render({ days: [first, empty, last] });
    expect(all('.ds-total')).toHaveLength(0);
    expect(all('.ds-dot').map((d) => d.getAttribute('data-point'))).toEqual(['c1', 'c3']);
    expect(all('[data-stack="agg"] .ds-layer')).toHaveLength(2);
  });

  it('collapses to the bar alone', () => {
    render();
    act(() => {
      button('Collapse the timeline').click();
    });
    expect(props.onCollapse).toHaveBeenCalledWith(true);
    render({ collapsed: true });
    expect(host?.querySelector('[data-testid="strip-chart"]')).toBeNull();
    expect(button('Expand the timeline').getAttribute('aria-expanded')).toBe('false');
  });
});
