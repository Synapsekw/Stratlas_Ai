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
import type { InventoryModel } from './inventory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const s = vi.hoisted(() => ({
  settings: null as SurveySettings | null,
  captures: [] as { id: string; date: string; label: string }[],
  stale: new Set<string>(),
  saveFile: vi.fn<
    (channel: string, req: { defaultName: string; data: string }) => Promise<unknown>
  >(() => Promise.resolve({ ok: true, value: { path: 'x.csv' } })),
}));
vi.mock('../compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) =>
    sel({ captures: s.captures, current: {}, seriesCurrent: {}, seriesInputs: {} }),
  isStale: (_s: unknown, m: { id: string }) => s.stale.has(m.id),
  seriesStale: () => false,
}));
vi.mock('../measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel({ settings: s.settings }),
}));
vi.mock('../card/CardActions', () => ({ CardActions: () => null, CardMenu: () => null }));
vi.mock('../../shell', () => ({
  bridge: { call: s.saveFile },
  useShell: (sel: (x: unknown) => unknown) => sel({ pkg: null }),
}));

const { VolumesHeader } = await import('./VolumesHeader');
const { datesPlayer } = await import('../../workspace/dates/datesPlayer');
const { timelapseStore } = await import('../../workspace/dates/timelapse');

const settings = defaultSurveySettings();
const CAPTURES = [
  { id: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
  { id: 'c2', date: '2021-01-10', label: 'Drone survey' },
];

const model = (over: Partial<InventoryModel> = {}): InventoryModel => ({
  on: { capture: 'c2', date: '2021-01-10', label: 'Drone survey' },
  previous: { capture: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
  volumeM3: 63402.1,
  piles: 19,
  tonnes: 100255,
  tonnesComplete: true,
  change: { m3: -12797, pct: -16.8 },
  groups: [],
  notCounted: [],
  partial: [],
  ...over,
});

const result = (net: number, capture: string): ComparisonResult => ({
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
  computedAt: '2026-10-05T00:00:00Z',
});
const pile = (id: string, over: Partial<SurveyMeasurement> = {}): SurveyMeasurement => ({
  id,
  family: 'polygon',
  tool: 'volume',
  label: `Pile ${id}`,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
  results: [],
  createdAt: '2026-10-05T00:00:00Z',
  ...over,
});

let host: HTMLDivElement;
let root: Root | undefined;
const render = (m: InventoryModel | null, piles: SurveyMeasurement[] = [pile('a')]) => {
  root ??= createRoot(host);
  act(() => {
    root?.render(<VolumesHeader model={m} piles={piles} />);
  });
};
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

beforeEach(() => {
  s.settings = settings;
  s.captures = CAPTURES;
  s.stale.clear();
  s.saveFile.mockClear();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('VolumesHeader', () => {
  it('shows the date in focus, volume, tonnes and change', () => {
    render(model());
    expect(host.querySelector('h3')?.textContent).toBe('Stockpile inventory');
    expect(text('volumes-date')).toBe('10 Jan 2021 · Drone survey');
    expect(text('volumes-kpi-volume')).toBe('63 402.1 m³');
    expect(text('volumes-kpi')).toContain('19 piles');
    expect(text('volumes-kpi-tonnes')).toBe('100 255 t');
    expect(text('volumes-kpi')).toContain('by material');
    expect(text('volumes-kpi')).toContain('vs 31 Dec');
    expect(text('volumes-kpi-change')).toBe('−12 797.0');
    expect(text('volumes-kpi')).toContain('m³ · −16.8 %');
    const change = host.querySelector('[data-testid="volumes-kpi-change"]')?.parentElement;
    expect(change?.getAttribute('data-sign')).toBe('loss');
  });

  it('a date named as its date says it once', () => {
    render(model({ on: { capture: 'c1', date: '2020-12-31', label: '31 Dec 2020' } }));
    expect(text('volumes-date')).toBe('31 Dec 2020');
  });

  it('the first survey has no change', () => {
    render(model({ previous: null, change: null }));
    expect(text('volumes-kpi-change')).toBe('-');
    expect(text('volumes-kpi')).toContain('first survey');
  });

  it('no density: no tonnes, never a zero', () => {
    render(model({ tonnes: null, tonnesComplete: false }));
    expect(text('volumes-kpi-tonnes')).toBe('-');
  });

  it('names the piles left out, with why', () => {
    render(model({ notCounted: [{ id: 'b', reason: 'stale' }], partial: ['a'] }), [
      pile('a'),
      pile('b'),
    ]);
    expect(text('volumes-status')).toContain('1 pile not counted: Pile b (stale)');
    expect(text('volumes-status')).toContain('Partly outside the survey: Pile a');
  });

  it('without a survey date there are no tiles', () => {
    render(null);
    expect(host.querySelector('[data-testid="volumes-kpi"]')).toBeNull();
  });

  it('Export writes every pile’s volume over time as CSV with the material density', async () => {
    s.settings = {
      ...settings,
      materials: [{ id: 'm1', name: 'Gravel', densityTPerM3: 2 }],
    };
    render(model(), [pile('a', { material: 'm1', results: [result(10, 'c2')] })]);
    await act(async () => {
      host
        .querySelector('[data-testid="volumes-csv"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(s.saveFile).toHaveBeenCalledTimes(1);
    const req = s.saveFile.mock.calls[0]?.[1];
    expect(req?.defaultName).toMatch(/\.csv$/);
    const lines = req?.data.split(/\r?\n/) ?? [];
    expect(lines[0]).toContain('Tonnage');
    expect(lines.find((l) => l.includes('2021-01-10'))).toMatch(/,20(\.0+)?,/);
  });

  it('Export weighs each date at the density its material had then', async () => {
    s.settings = {
      ...settings,
      materials: [
        {
          id: 'm1',
          name: 'Gravel',
          densityTPerM3: 2,
          densityHistory: [
            { tPerM3: 1.5, fromCapture: 'c1' },
            { tPerM3: 2, fromCapture: 'c2' },
          ],
        },
      ],
    };
    render(model(), [
      pile('a', { material: 'm1', results: [result(10, 'c2')], series: [result(10, 'c1')] }),
    ]);
    await act(async () => {
      host
        .querySelector('[data-testid="volumes-csv"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const lines = s.saveFile.mock.calls[0]?.[1].data.split(/\r?\n/) ?? [];
    expect(lines.find((l) => l.includes('2020-12-31'))).toMatch(/,15(\.0+)?,/);
    expect(lines.find((l) => l.includes('2021-01-10'))).toMatch(/,20(\.0+)?,/);
  });

  it('the CSV says stale for a stale figure, as the totals do', async () => {
    s.stale.add('a');
    render(model(), [pile('a', { series: [result(8, 'c1')], results: [result(10, 'c2')] })]);
    await act(async () => {
      host
        .querySelector('[data-testid="volumes-csv"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const lines = s.saveFile.mock.calls.at(-1)?.[1].data.split(/\r?\n/) ?? [];
    expect(lines.find((l) => l.includes('2021-01-10'))).toMatch(/,stale,/);
    expect(lines.find((l) => l.includes('2020-12-31'))).toMatch(/,ok,/);
  });
});

describe('VolumesHeader during playback', () => {
  const T0 = Date.parse('2020-12-31T00:00:00Z');
  const T1 = Date.parse('2021-01-10T00:00:00Z');
  afterEach(() => {
    datesPlayer.setState({ playing: false, frame: null, t: null });
    timelapseStore.setState({ days: [] });
  });

  it('the panel shows the last survey passed and never a value between surveys', () => {
    const day = (capture: string, t: number, label: string, short: string, v: number) => ({
      capture,
      t,
      label,
      short,
      colour: 'var(--date-1)',
      volumeM3: v,
    });
    timelapseStore.setState({
      days: [
        day('c1', T0, '31 Dec 2020', '31 Dec', 76199.4),
        day('c2', T1, '10 Jan 2021', '10 Jan', 63402.4),
      ],
    });
    const mid = T0 + (T1 - T0) * 0.55;
    datesPlayer.setState({
      playing: true,
      t: mid,
      frame: { t: mid, passed: T0, next: T1, f: 0.55, ended: false },
    });
    // a is on both dates (70 000 then 60 000), b only on 31 Dec: the change the next survey
    // brings is over the piles on both, never the totals' difference
    const piles = [
      pile('a', { results: [result(60000, 'c2')], series: [result(70000, 'c1')] }),
      pile('b', { results: [result(6199.4, 'c1')] }),
    ];
    render(
      model({
        on: { capture: 'c1', date: '2020-12-31', label: '31 Dec 2020' },
        previous: null,
        volumeM3: 76199.4,
        change: null,
      }),
      piles,
    );
    expect(text('volumes-date')).toBe('31 Dec 2020 · last survey passed');
    expect(text('volumes-kpi-volume')).toBe('76 199.4 m³');
    expect(text('volumes-kpi-next')).toBe('Next survey−10 000.0m³ · 10 Jan');
  });
});
