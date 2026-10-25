// @vitest-environment jsdom
import { formatQuantity } from '@aio/geo';
import { defaultSurveySettings, type SurveyMeasurement } from '@aio/schema';
import { pileAxis, type HeightSampler } from '@aio/survey';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileChartProps } from '../../charts/ProfileChart';
import type { SurfaceState } from '../surfaceStates';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeTiles {
  id: string;
  fingerprint: string;
}
const s = vi.hoisted(() => ({
  dates: [] as {
    capture: string;
    label: string;
    date: string;
    state: SurfaceState;
    tiles: FakeTiles | null;
  }[],
  chart: null as ProfileChartProps | null,
  section: { window: false, source: null },
}));
const calls = vi.hoisted(() => ({
  run: vi.fn(() =>
    Promise.resolve({ results: [{ cutM3: 4403.1, fillM3: 19.6 }], heat: [], shares: [], ms: 1 }),
  ),
  openSection: vi.fn(),
  sample: vi.fn(),
  setWindow: vi.fn(),
  addToReport: vi.fn(() => Promise.resolve('added')),
}));

vi.mock('../card/slots', () => ({
  useSurveyDates: () => s.dates,
  // the cards' loader, without its cache
  useLoaded: <T,>(key: string | null, load: () => Promise<T>) => {
    const [got, setGot] = useState<{ key: string; value: T } | null>(null);
    useEffect(() => {
      if (key === null) return;
      let live = true;
      void load().then((value) => {
        if (live) setGot({ key, value });
      });
      return () => {
        live = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    if (key === null) return { status: 'idle' };
    return got?.key === key ? { status: 'ready', value: got.value } : { status: 'loading' };
  },
}));
// the earlier survey is flat at 10 m; the later one falls to 7.04 m from E 20 on
vi.mock('../card/pointHistory', () => ({
  surfaceTiles: () => () => Promise.resolve(null),
  withSurface: <T,>(compute: (h: HeightSampler) => T, tiles: FakeTiles) => {
    calls.sample(tiles.id);
    return Promise.resolve(
      compute({
        heightAt: (e: number) => (tiles.id === 's1' ? 10 : e < 20 ? 9 : 7.04),
      }),
    );
  },
  emptyReason: () => 'mcard.notMeasured',
}));
vi.mock('../qaStore', () => ({ useQa: (sel: (x: unknown) => unknown) => sel({ surfaces: [] }) }));
vi.mock('../qaHelpers', () => ({ useFocusCapture: () => null }));
vi.mock('../surfaceStates', () => ({ usePreparingSoon: () => false }));
vi.mock('../measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel({ settings: defaultSurveySettings() }),
}));
vi.mock('../compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel({ status: 'ready' }),
  engineClient: () => ({ run: calls.run }),
  ringOf: (pts: readonly number[][]) => pts.map((p) => [p[0], p[1]]),
}));
vi.mock('../sectionStore', () => ({
  openSection: calls.openSection,
  setWindow: calls.setWindow,
  sectionStore: { getState: () => s.section },
}));
vi.mock('../../report/templateStore', () => ({ addToReport: calls.addToReport }));
vi.mock('../../charts/exportChart', () => ({ chartPng: vi.fn(), savePng: vi.fn() }));
vi.mock('../../charts/ProfileChart', () => ({
  DEFAULT_PLOT: { width: 526, height: 158 },
  ProfileChart: (p: ProfileChartProps) => {
    s.chart = p;
    return (
      <div
        data-testid="pile-profile-chart"
        data-series={p.series.map((x) => `${x.key}:${x.kind}`).join(',')}
        data-shade={p.shadeVs ?? ''}
        data-hover={p.hoverAt ?? ''}
      />
    );
  },
}));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { id: 'p1', manifest: { captures: [], layers: [] } } }),
}));

const { PileProfile } = await import('./PileProfile');
const { pileView } = await import('./pileView');
const { linkedHover } = await import('../linkedHover');

const NOW = '2026-10-24T00:00:00.000Z';
const m: SurveyMeasurement = {
  id: '02',
  family: 'polygon',
  tool: 'volume',
  label: 'Pile 02',
  scope: { kind: 'site' },
  points: [
    [0, 0, 10],
    [40, 0, 10],
    [40, 20, 10],
    [0, 20, 10],
  ],
  items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
  results: [],
  createdAt: NOW,
};
const settings = defaultSurveySettings();

let host: HTMLDivElement;
let root: Root | undefined;
const render = async () => {
  root ??= createRoot(host);
  await act(async () => {
    root?.render(<PileProfile m={m} />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
};
const q = (sel: string) => host.querySelector(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  pileView.setState({ axis: new Map() });
  linkedHover.setState({ lines: new Map(), hover: null, pin: null, fly: null });
  s.chart = null;
  s.section = { window: false, source: null };
  s.dates = [
    {
      capture: 'c1',
      label: '31 Dec 2020',
      date: '2020-12-31',
      state: { kind: 'ready' },
      tiles: { id: 's1', fingerprint: 'f1' },
    },
    {
      capture: 'c2',
      label: '10 Jan 2021',
      date: '2021-01-10',
      state: { kind: 'ready' },
      tiles: { id: 's2', fingerprint: 'f2' },
    },
  ];
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('PileProfile', () => {
  it('Profile draws one series per ready date along the long axis and registers pile:<id>', async () => {
    await render();
    const axis = pileAxis(m.points);
    expect(q('[data-testid="pile-profile-chart"]')?.getAttribute('data-series')).toBe(
      'c1:earlier,c2:current',
    );
    // shaded against the earlier date by default
    expect(q('[data-testid="pile-profile-chart"]')?.getAttribute('data-shade')).toBe('c1');
    const line = linkedHover.getState().lines.get('pile:02');
    expect(line?.polyline).toEqual([axis.a, axis.b]);
    expect(line?.series.map((x) => x.key)).toEqual(['c1', 'c2']);
    expect(text('[data-testid="pile-line"]')).toBe(
      `Line: long axis · ${formatQuantity(axis.lengthM, 'distance', settings.units, settings.precision)}`,
    );
    // one chip per date shown
    expect(q('[data-testid="pile-chips"]')?.textContent).toContain('31 Dec 2020');
    expect(q('[data-testid="pile-chips"]')?.textContent).toContain('10 Jan 2021');
    // the line is let go when the profile closes
    act(() => root?.unmount());
    root = undefined;
    expect(linkedHover.getState().lines.has('pile:02')).toBe(false);
  });

  it('follows a turned line kept for the pile', async () => {
    const turned = pileAxis(m.points, { angleDeg: 90 });
    pileView.getState().setAxis('02', turned);
    await render();
    expect(linkedHover.getState().lines.get('pile:02')?.polyline).toEqual([turned.a, turned.b]);
  });

  it('the chart follows the shared point and drives it', async () => {
    await render();
    act(() => {
      linkedHover.getState().setHover({ key: 'pile:02', chainageM: 12, source: '3d' });
    });
    expect(q('[data-testid="pile-profile-chart"]')?.getAttribute('data-hover')).toBe('12');
    act(() => {
      s.chart?.onHover?.(5);
    });
    expect(linkedHover.getState().hover).toEqual({ key: 'pile:02', chainageM: 5, source: 'chart' });
    act(() => {
      s.chart?.onPinAt?.(7);
    });
    expect(linkedHover.getState().pin?.chainageM).toBe(7);
    act(() => {
      s.chart?.onFly?.(9);
    });
    expect(linkedHover.getState().fly).toMatchObject({ key: 'pile:02', chainageM: 9 });
  });

  it('shows cut and fill over the whole pile from the engine and the largest drop', async () => {
    await render();
    expect(calls.run).toHaveBeenCalledTimes(1);
    const [req] = calls.run.mock.calls[0] as unknown as [
      { items: { from: unknown; to: unknown }[] },
    ];
    expect(req.items[0]?.from).toEqual({ kind: 'survey', surface: 's1', capture: 'c1' });
    expect(req.items[0]?.to).toEqual({ kind: 'survey', surface: 's2', capture: 'c2' });
    expect(text('[data-testid="pile-cut"]')).toContain('4 403.1');
    expect(text('[data-testid="pile-fill"]')).toContain('19.6');
    // in the project's distance precision
    const drop = formatQuantity(2.96, 'distance', settings.units, settings.precision);
    expect(text('[data-testid="pile-drop"]')).toBe(`Largest drop −${drop} at 22 m`);
    // a sentence in the UI font: only its figures are set in mono
    const figures = [...(q('[data-testid="pile-drop"]')?.querySelectorAll('.mono') ?? [])];
    expect(figures.map((f) => f.textContent)).toEqual([`−${drop}`, '22 m']);
  });

  it('while a date prepares the placeholder names it and the ready line still draws', async () => {
    s.dates = s.dates.map((x) =>
      x.capture === 'c1' ? { ...x, state: { kind: 'preparing', pct: 40 }, tiles: null } : x,
    );
    await render();
    expect(text('[data-testid="pile-building"]')).toBe(
      'Building the height surface for 31 Dec 2020… The 10 Jan 2021 line is ready; 31 Dec 2020 and the cut/fill shading appear when it finishes.',
    );
    expect(q('[data-testid="pile-profile-chart"]')?.getAttribute('data-series')).toBe('c2:current');
  });

  it('Open larger opens the section window along the line', async () => {
    // an older date not shown yet: the chips offer it
    s.dates = [
      {
        capture: 'c0',
        label: '01 Dec 2020',
        date: '2020-12-01',
        state: { kind: 'ready' },
        tiles: { id: 's0', fingerprint: 'f0' },
      },
      ...s.dates,
    ];
    await render();
    const open = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open larger');
    expect(open).toBeDefined();
    expect(q('[data-testid="pile-chips-add"]')?.textContent).toBe('+ Date or design');
    act(() => {
      open?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const axis = pileAxis(m.points);
    expect(calls.openSection).toHaveBeenCalledWith(
      [axis.a, axis.b],
      expect.objectContaining({ kind: 'measurement', id: '02' }),
    );
    expect(calls.setWindow).toHaveBeenCalledWith(true);
  });

  it('a line dragged in the scene keeps the chart and its link, and is read again once it rests', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await render();
      const axis = pileAxis(m.points);
      expect(calls.sample).toHaveBeenCalledTimes(2);
      act(() => {
        linkedHover.getState().setPin({ key: 'pile:02', chainageM: 7, source: 'chart' });
      });
      // a drag: the line moves every frame
      for (const deg of [10, 20, 30]) {
        await act(async () => {
          pileView.getState().setAxis('02', pileAxis(m.points, { angleDeg: deg }));
          await Promise.resolve();
        });
        await act(async () => {
          vi.advanceTimersByTime(40);
          await Promise.resolve();
        });
      }
      // nothing read yet: the chart stays with the last line, still linked, the pin kept
      expect(calls.sample).toHaveBeenCalledTimes(2);
      expect(q('[data-testid="pile-profile-chart"]')).not.toBeNull();
      expect(text('[role="status"]')).not.toContain('Reading');
      expect(linkedHover.getState().lines.get('pile:02')?.polyline).toEqual([axis.a, axis.b]);
      expect(linkedHover.getState().pin?.chainageM).toBe(7);
      // at rest: read once along the new line
      await act(async () => {
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(calls.sample).toHaveBeenCalledTimes(4);
      const now = pileAxis(m.points, { angleDeg: 30 });
      expect(linkedHover.getState().lines.get('pile:02')?.polyline).toEqual([now.a, now.b]);
      expect(q('[data-testid="pile-profile-chart"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the section window opened larger follows the line moved afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await render();
      const open = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === 'Open larger',
      );
      act(() => {
        open?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(calls.openSection).toHaveBeenCalledTimes(1);
      const source = calls.openSection.mock.calls[0]?.[1] as never;
      s.section = { window: true, source };
      const turned = pileAxis(m.points, { angleDeg: 45 });
      act(() => {
        pileView.getState().setAxis('02', turned);
        vi.advanceTimersByTime(200);
      });
      expect(calls.openSection).toHaveBeenCalledTimes(2);
      expect(calls.openSection).toHaveBeenLastCalledWith([turned.a, turned.b], source);
      // closed: the pile no longer leads it
      s.section = { window: false, source };
      act(() => {
        pileView.getState().setAxis('02', pileAxis(m.points, { angleDeg: 60 }));
        vi.advanceTimersByTime(200);
      });
      expect(calls.openSection).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
