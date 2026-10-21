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
  measure: {} as {
    settings: SurveySettings;
    readOnly: boolean;
    selected: string[];
    templates: { project: never[]; user: never[] };
    file: { measurements: SurveyMeasurement[] };
  },
}));
const computeAll = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const recomputeCarried = vi.hoisted(() => vi.fn(() => Promise.resolve([] as string[])));
const compare = vi.hoisted(() => ({
  current: {},
  surfaces: [],
  designs: [],
  captures: [] as { id: string; date: string; label: string }[],
  seriesCurrent: {},
  seriesInputs: {},
}));
const stale = vi.hoisted(() => new Set<string>());
vi.mock('./compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel(compare),
  isStale: (_s: unknown, m: { id: string }) => stale.has(m.id),
  seriesStale: () => false,
  computeAll,
  recomputeCarried,
  hasCarried: (m: SurveyMeasurement) => m.results.some((r) => r.carried !== undefined),
}));
vi.mock('./measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  knownTemplates: () => [],
  replaceMeasurement: vi.fn(),
}));

const { BulkTotals } = await import('./BulkTotals');

const result = (net: number): ComparisonResult => ({
  item: 'a',
  status: 'ok',
  cutM3: 1,
  fillM3: net + 1,
  netM3: net,
  totalM3: net + 2,
  areaM2: 100,
  areaCutM2: 0,
  areaFillM2: 100,
  areaUnchangedM2: 0,
  uncoveredM2: 0,
  fromLabel: 'Triangulated toe',
  toLabel: 'c2',
  toCapture: 'c2',
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: 'sha256:x',
  computedAt: '2026-10-05T00:00:00.000Z',
});
const pile = (id: string, net: number): SurveyMeasurement => ({
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
  results: [result(net)],
  createdAt: '2026-10-05T00:00:00.000Z',
});

let host: HTMLDivElement;
let root: Root | undefined;
const settings = defaultSurveySettings();
beforeEach(() => {
  stale.clear();
  compare.captures = [
    { id: 'c1', date: '2026-01-10', label: '10 Jan' },
    { id: 'c2', date: '2026-02-10', label: '10 Feb' },
  ];
  s.measure = {
    settings,
    readOnly: false,
    selected: ['a', 'b'],
    templates: { project: [], user: [] },
    file: { measurements: [pile('a', 10), pile('b', 5)] },
  };
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('BulkTotals', () => {
  it('totals the selection, in words from the catalogue, with the shared button', () => {
    root = createRoot(host);
    act(() => {
      root?.render(<BulkTotals />);
    });
    expect(host.querySelector('h2')?.textContent).toBe('2 measurements');
    expect(host.querySelector('[data-testid="survey-bulk-net"]')?.textContent).toBe(
      formatQuantity(15, 'volume', settings.units, settings.precision),
    );
    const recompute = host.querySelector('[data-testid="survey-bulk-recompute"]');
    expect(recompute?.textContent).toContain('Recompute all');
    expect(recompute?.classList.contains('btn')).toBe(true);
    expect(host.querySelector('legend')?.textContent).toBe('Change for all');
    act(() => {
      recompute?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(computeAll).toHaveBeenCalledWith(['a', 'b']);
  });

  it('Recompute all leaves carried piles; their own action asks first', async () => {
    const old = pile('b', 5);
    s.measure.file = {
      measurements: [
        pile('a', 10),
        {
          ...old,
          results: old.results.map((r) => ({
            ...r,
            carried: { from: 'kit' as const, base: 'plane', pile: 'P01', epoch: 'e1' },
          })),
        },
      ],
    };
    root = createRoot(host);
    act(() => {
      root?.render(<BulkTotals />);
    });
    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);
    expect(q('survey-bulk-carried-note')?.textContent).toContain('1 pile');
    const own = q('survey-bulk-recompute-carried');
    expect(own?.textContent).toBe('Recompute 1 earlier-version pile with the standard base');
    act(() => {
      own?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // asks in the app's own dialog, nothing run yet
    expect(q('survey-bulk-carried-confirm')?.getAttribute('role')).toBe('alertdialog');
    expect(recomputeCarried).not.toHaveBeenCalled();
    act(() => {
      q('survey-bulk-carried-confirm-cancel')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(q('survey-bulk-carried-confirm')).toBeNull();
    expect(recomputeCarried).not.toHaveBeenCalled();
    act(() => {
      own?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      q('survey-bulk-carried-confirm-yes')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(recomputeCarried).toHaveBeenCalledWith(['b']);
    // read-only: no way to replace them
    s.measure.readOnly = true;
    act(() => {
      root?.render(<BulkTotals />);
    });
    expect(q('survey-bulk-recompute-carried')).toBeNull();
  });

  const render = () => {
    root ??= createRoot(host);
    act(() => {
      root?.render(<BulkTotals />);
    });
  };
  const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent;
  const v = (x: number) => formatQuantity(x, 'volume', settings.units, settings.precision);

  it('selected volumes follow the volumes view rule: current figures of the latest date', () => {
    // b is stale; c's figure is for an earlier date than the latest survey
    const c = { ...pile('c', 7), results: [{ ...result(7), toCapture: 'c1' }] };
    s.measure.selected = ['a', 'b', 'c'];
    s.measure.file = { measurements: [pile('a', 10), pile('b', 5), c] };
    stale.add('b');
    render();
    expect(text('survey-bulk-net')).toBe(v(10));
    expect(host.querySelector('th[scope="row"]')?.textContent).toContain('Total on 10 Feb');
    expect(text('survey-bulk-not-counted')).toBe(
      '2 piles not counted: Pile b (stale), Pile c (not computed yet)',
    );
    // the area is the counted piles' only: one 10 x 10 triangle
    expect(text('survey-bulk-area')).toBe(
      formatQuantity(50, 'area', settings.units, settings.precision),
    );
  });

  it('selected volumes with nothing counted show no figure, never 0', () => {
    stale.add('a');
    stale.add('b');
    render();
    expect(text('survey-bulk-net')).toBe('-');
    expect(text('survey-bulk-area')).toBe('-');
    expect(text('survey-bulk-not-counted')).toContain('Pile a (stale), Pile b (stale)');
  });

  it('a mixed selection totals its volumes by the same rule as the volumes view', async () => {
    const { setSeriesFailed } = await import('./useInventory');
    // a counts; b is stale; d's figure is for an earlier date and its dates failed; c is an area
    const d = { ...pile('d', 7), results: [{ ...result(7), toCapture: 'c1' }] };
    s.measure.selected = ['a', 'b', 'c', 'd'];
    s.measure.file = {
      measurements: [pile('a', 10), pile('b', 5), { ...pile('c', 3), tool: 'area' }, d],
    };
    stale.add('b');
    setSeriesFailed('d', 'the engine stopped');
    try {
      render();
      // the pile figure of a, plus the area tool's current figure: never b's or d's
      expect(text('survey-bulk-net')).toBe(v(13));
      expect(text('survey-bulk-not-counted')).toBe(
        '2 piles not counted: Pile b (stale), Pile d (could not compute: the engine stopped)',
      );
      // the counted pile's area and the area tool's
      expect(text('survey-bulk-area')).toBe(
        formatQuantity(100, 'area', settings.units, settings.precision),
      );
    } finally {
      setSeriesFailed('d', null);
    }
  });

  it('other measurements keep their per-comparison totals', () => {
    s.measure.file = {
      measurements: [
        { ...pile('a', 10), tool: 'area' },
        { ...pile('b', 5), tool: 'area' },
      ],
    };
    render();
    expect(text('survey-bulk-net')).toBe(v(15));
    expect(host.querySelector('[data-testid="survey-bulk-not-counted"]')).toBeNull();
  });
});
