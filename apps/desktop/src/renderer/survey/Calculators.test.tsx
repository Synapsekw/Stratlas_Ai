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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const s = vi.hoisted(() => ({
  measure: {} as { settings: SurveySettings; readOnly: boolean; kitDensity: null },
  surveys: [] as { id: string; date: string }[],
}));

vi.mock('./measureStore', () => ({
  useMeasure: (sel: (x: unknown) => unknown) => sel(s.measure),
  updateMeasurement: vi.fn(),
}));
vi.mock('./compareStore', () => ({
  useCompare: (sel: (x: unknown) => unknown) => sel({ tonnes: {} }),
  setTonnes: vi.fn(),
  openCompareDialog: vi.fn(),
}));
vi.mock('@aio/annotate', () => ({ useAnnotateReadOnly: () => false }));
vi.mock('@aio/workspace', () => ({
  useWorkspace: (sel: (x: unknown) => unknown) =>
    sel({ project: { id: 'p1', manifest: { captures: s.surveys, layers: [] } } }),
}));

const { Calculators } = await import('./Calculators');

const result = (to: string, net: number): ComparisonResult => ({
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
  fromLabel: 'base',
  toLabel: to,
  toCapture: to,
  deadbandM: 0,
  usedDeadband: false,
  cellM: 0.5,
  engine: 'ts',
  fingerprint: 'sha256:x',
  computedAt: '2026-10-24T00:00:00Z',
});

const pile = (capture: string): SurveyMeasurement => ({
  id: 'p',
  family: 'polygon',
  tool: 'volume',
  label: 'Pile',
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
  results: [result(capture, 100)],
  material: 'agg',
  createdAt: '2026-10-24T00:00:00Z',
});

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  s.surveys = [
    { id: 'd1', date: '2020-12-31' },
    { id: 'd2', date: '2021-01-10' },
  ];
  s.measure = {
    readOnly: false,
    kitDensity: null,
    settings: {
      ...defaultSurveySettings(),
      materials: [
        {
          id: 'agg',
          name: 'Aggregate',
          densityTPerM3: 2,
          densityHistory: [
            { fromCapture: 'd1', tPerM3: 1.5 },
            { fromCapture: 'd2', tPerM3: 2 },
          ],
        },
      ],
    },
  };
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

describe('Calculators', () => {
  it('weighs the figure at the density on its own date (review finding 2)', () => {
    root = createRoot(host);
    act(() => {
      root?.render(<Calculators m={pile('d1')} />);
    });
    const tonnes = host.querySelector('[data-testid="survey-calc-tonnes"]')?.textContent ?? '';
    expect(tonnes).toContain('150');
    expect(tonnes).toContain('1.5');
  });
});
