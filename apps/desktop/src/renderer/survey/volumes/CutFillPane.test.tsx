// @vitest-environment jsdom
import {
  defaultSurveySettings,
  type ComparisonResult,
  type HeightTiles,
  type SurveyMeasurement,
} from '@aio/schema';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRequest, SiteRequest } from '../engineProtocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const s = vi.hoisted(() => ({
  compare: Object.create(null) as Record<string, unknown>,
  measure: Object.create(null) as Record<string, unknown>,
  focus: 'c2',
  project: Object.create(null) as Record<string, unknown>,
}));
const engine = vi.hoisted(() => ({
  run: vi.fn<(req: RunRequest, key?: string) => Promise<{ results: ComparisonResult[] }>>(),
  site: vi.fn<(req: SiteRequest, key?: string) => Promise<{ result: ComparisonResult }>>(),
  save: vi.fn(() => Promise.resolve({ ok: true, value: {} })),
}));

vi.mock('../compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel(s.compare),
  engineClient: () => ({ run: engine.run, site: engine.site }),
  isStale: () => false,
  seriesStale: () => false,
}));
vi.mock('../measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  select: vi.fn(),
}));
vi.mock('../qaHelpers', () => ({ useFocusCapture: () => s.focus }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) => sel({ project: s.project }),
  // the compare pair follows the open project; the pane's tests set the pair themselves
  workspace: { getState: () => ({ project: null }), subscribe: () => () => undefined },
  dateTags: () => ({ c1: { colour: 'var(--date-1)' }, c2: { colour: 'var(--date-2)' } }),
}));
vi.mock('../../shell', () => ({ bridge: { call: engine.save } }));

const { CutFillPane } = await import('./CutFillPane');
const { compareDates } = await import('../../workspace/dates/compareDates');
const { cutFillPrefs, clearCutFillCache } = await import('./cutFill');

const CAPTURES = [
  { id: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
  { id: 'c2', date: '2021-01-10', label: '10 Jan 2021' },
  { id: 'c3', date: '2021-02-01', label: '1 Feb 2021' },
];
const tiles = (id: string, capture: string) =>
  ({
    id,
    capture,
    cellM: 0.5,
    bounds: [0, 0, 0, 100, 100, 0],
    source: { kind: 'dsm' },
  }) as unknown as HeightTiles;

const pile = (n: number): SurveyMeasurement =>
  ({
    id: `m${n}`,
    label: `Pile ${String(n).padStart(2, '0')}`,
    tool: 'volume',
    family: 'polygon',
    scope: { kind: 'site' },
    points: [
      [n, 0, 0],
      [n + 1, 0, 0],
      [n + 1, 1, 0],
    ],
    items: [],
    results: [],
  }) as unknown as SurveyMeasurement;

const res = (cut: number, fill: number, over: Partial<ComparisonResult> = {}) =>
  ({
    item: 'cutfill',
    status: 'ok',
    cutM3: cut,
    fillM3: fill,
    netM3: fill - cut,
    totalM3: cut + fill,
    ...over,
  }) as ComparisonResult;

/** Per pile (by its first ring x): cut and fill. */
let figures = new Map<number, [number, number]>();

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function flush() {
  for (let i = 0; i < 6; i++) await act(() => new Promise<void>((r) => setTimeout(r, 0)));
}

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<CutFillPane />));
  await flush();
  return host;
}

function q(sel: string): HTMLElement;
function q<K extends keyof HTMLElementTagNameMap>(sel: string, tag: K): HTMLElementTagNameMap[K];
function q(sel: string, tag?: string): Element {
  const el = host?.querySelector(sel);
  if (!el || (tag && el.tagName.toLowerCase() !== tag)) throw new Error(`no ${sel}`);
  return el;
}
const all = (sel: string) => [...(host?.querySelectorAll<HTMLElement>(sel) ?? [])];
const text = (sel: string) => host?.querySelector(sel)?.textContent ?? '';

function setPiles(n: number) {
  const piles = Array.from({ length: n }, (_, i) => pile(i + 1));
  s.measure = {
    settings: defaultSurveySettings(),
    file: { measurements: piles },
  };
}

beforeEach(() => {
  localStorage.clear();
  s.focus = 'c2';
  s.project = { id: 'p1', manifest: { captures: CAPTURES } };
  s.compare = {
    status: 'ready',
    surfaces: [tiles('s1', 'c1'), tiles('s2', 'c2'), tiles('s3', 'c3')],
    captures: CAPTURES,
    current: {},
    seriesCurrent: {},
    seriesInputs: {},
  };
  clearCutFillCache();
  setPiles(3);
  figures = new Map([
    [1, [5115.9, 0]],
    [2, [4383.5, 0]],
    [3, [0, 217.9]],
  ]);
  compareDates.setState({ on: false, from: null, to: null });
  cutFillPrefs.setState({ project: null, thresholdM: 0.1, area: 'piles' });
  engine.run.mockReset();
  engine.run.mockImplementation((req) => {
    const x = req.ring[0]?.[0] ?? 0;
    const [cut, fill] = figures.get(x) ?? [0, 0];
    return Promise.resolve({ results: [res(cut, fill)] });
  });
  engine.site.mockReset();
  engine.site.mockResolvedValue({ result: res(24297.1, 2098.8) });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('the Cut & fill pane', () => {
  it('the pane shows Cut, Fill, Net with the pile count and the whole-site line with Inside piles', async () => {
    await render();
    expect(q('[data-testid="cutfill-pane"]')).toBeTruthy();
    expect(text('[data-kpi="cut"]')).toContain('9 499.4');
    expect(text('[data-kpi="cut"]')).toContain('m³ removed');
    expect(text('[data-kpi="fill"]')).toContain('217.9');
    expect(text('[data-kpi="fill"]')).toContain('m³ added');
    expect(text('[data-kpi="net"]')).toContain('−9 281.5');
    expect(text('[data-kpi="net"]')).toContain('m³ · 3 piles');
    expect(text('.cf-site-line')).toBe(
      'Whole site: cut 24 297.1 · fill 2 098.8 · net −22 198.3 m³',
    );
    const runItem = engine.run.mock.calls[0]?.[0].items[0];
    expect(runItem).toMatchObject({
      from: { kind: 'survey', surface: 's1' },
      to: { kind: 'survey', surface: 's2' },
      useDeadband: true,
      deadbandM: 0.1,
    });
  });

  it('whole site shows the site figures and passes the threshold to the engine', async () => {
    await render();
    const site = all('.cf-area button').find((b) => b.textContent === 'Whole site');
    act(() => site?.click());
    await flush();
    expect(site?.getAttribute('aria-pressed')).toBe('true');
    expect(text('[data-kpi="cut"]')).toContain('24 297.1');
    expect(text('[data-kpi="net"]')).not.toContain('piles');
    expect(host?.querySelector('.cf-site-line')).toBeNull();
    expect(engine.site.mock.calls.at(-1)?.[0]).toMatchObject({ deadbandM: 0.1 });
  });

  it('bars sort by net and fold the rest', async () => {
    setPiles(15);
    figures = new Map(
      Array.from({ length: 15 }, (_, i): [number, [number, number]] => [
        i + 1,
        i < 2 ? [0, 3 + i * 10] : [100 * i, 0],
      ]),
    );
    await render();
    const labels = all('.cf-bar-label').map((e) => e.textContent);
    expect(labels).toHaveLength(13);
    expect(labels[0]).toBe('P15');
    expect(labels.at(-1)).toBe('P03');
    expect(labels).not.toContain('P01');
    expect(labels).not.toContain('P02');
    expect(text('.cf-folded')).toBe('+ 2 piles within ±13 m³');
    expect(text('.cf-bar-head')).toBe('cut ◂ │ ▸ fill · net m³');
  });

  it('the pair defaults to the survey before the focus and the focus, in the shared compare pair', async () => {
    s.focus = 'c3';
    await render();
    expect(compareDates.getState()).toMatchObject({ from: 'c2', to: 'c3', on: false });
    expect(q('select[aria-label="From"]', 'select').value).toBe('c2');
    expect(q('select[aria-label="To"]', 'select').value).toBe('c3');
  });

  it('From after To swaps', async () => {
    await render();
    const from = q('select[aria-label="From"]', 'select');
    act(() => {
      from.value = 'c3';
      from.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(compareDates.getState()).toMatchObject({ from: 'c2', to: 'c3' });
    expect(q('select[aria-label="To"]', 'select').value).toBe('c3');
  });

  it('follows the shared pair when the strip changes it', async () => {
    await render();
    act(() => {
      compareDates.getState().set('c1', 'c3');
    });
    await flush();
    expect(q('select[aria-label="To"]', 'select').value).toBe('c3');
    expect(engine.run.mock.calls.at(-1)?.[0].items[0]?.to).toMatchObject({ surface: 's3' });
  });

  it('the threshold is passed to the engine and kept for the project', async () => {
    await render();
    const input = q('input[aria-label="Ignore height changes smaller than, in metres"]', 'input');
    expect(input.value).toBe('0.10');
    act(() => {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc?.set?.call(input, '0.25');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await flush();
    expect(engine.run.mock.calls.at(-1)?.[0].items[0]).toMatchObject({ deadbandM: 0.25 });
    expect(localStorage.getItem('stratlas.cutFill.p1')).toContain('0.25');
  });

  it('a date without a prepared surface waits for it and computes nothing', async () => {
    s.compare = { ...s.compare, surfaces: [tiles('s2', 'c2')] };
    await render();
    expect(text('.cf-status')).toBe('Change: waiting for 31 Dec 2020');
    expect(engine.run).not.toHaveBeenCalled();
    expect(host?.querySelector('[data-kpi="cut"]')).toBeNull();
  });

  it('a pile the engine refused is named as not counted, never counted as zero', async () => {
    engine.run.mockImplementation((req) =>
      Promise.resolve({
        results: [
          (req.ring[0]?.[0] ?? 0) === 2
            ? res(0, 0, { status: 'refused', reason: 'outside' })
            : res(10, 0),
        ],
      }),
    );
    await render();
    expect(text('[data-kpi="net"]')).toContain('m³ · 2 piles');
    expect(text('.cf-not-counted')).toContain('P02');
  });

  it('Export saves the by-pile figures as CSV', async () => {
    await render();
    const btn = all('button').find((b) => b.textContent === 'Export');
    await act(async () => {
      btn?.click();
      await Promise.resolve();
    });
    const arg = (engine.save.mock.calls[0] as unknown[] | undefined)?.[1] as
      { defaultName: string; data: string } | undefined;
    expect(arg?.defaultName).toMatch(/\.csv$/);
    expect(arg?.data.split('\n')[1]).toBe('P01,5115.90,0.00,-5115.90');
  });
});
