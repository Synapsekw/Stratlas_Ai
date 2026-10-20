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
vi.mock('./compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) =>
    sel({ current: {}, surfaces: [], designs: [], captures: [] }),
  isStale: () => false,
  computeAll,
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
});
