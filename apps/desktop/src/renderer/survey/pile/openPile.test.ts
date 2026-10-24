// @vitest-environment jsdom
import type { SurveyMeasurement } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followMeasureTool } from '../../workspace/workbench/measureFollow';
import { createWorkbenchStore } from '../../workspace/workbench/workbenchStore';
import { measureStore } from '../measureStore';
import { isPile, openMeasurement, openPile } from './openPile';

vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: () => null,
  shell: { getState: () => ({}) },
}));
vi.mock('../../issueCard/state', () => ({ isIssueEditing: () => false }));

const m = (
  id: string,
  tool: SurveyMeasurement['tool'],
  family: SurveyMeasurement['family'],
): SurveyMeasurement => ({
  id,
  family,
  tool,
  label: id,
  scope: { kind: 'site' },
  points: [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
  ],
  items: [],
  results: [],
  createdAt: '2026-10-24T00:00:00Z',
});

let bench: ReturnType<typeof createWorkbenchStore>;
let off: () => void;

beforeEach(() => {
  bench = createWorkbenchStore(null);
  measureStore.setState({
    tool: null,
    draw: null,
    editing: null,
    focus: null,
    selected: [],
    file: {
      schema: 'aio.measurements/1',
      measurements: [m('pile1', 'volume', 'polygon'), m('line1', 'distance', 'line')],
    },
  });
  off = followMeasureTool(measureStore, bench);
});
afterEach(() => {
  off();
});

describe('isPile', () => {
  it('is a volume polygon only', () => {
    expect(isPile(m('a', 'volume', 'polygon'))).toBe(true);
    expect(isPile(m('b', 'area', 'polygon'))).toBe(false);
    expect(isPile(m('c', 'distance', 'line'))).toBe(false);
  });
});

describe('openPile', () => {
  it('selects the pile and brings the Volumes tab, not Measure', () => {
    openPile('pile1', bench);
    expect(measureStore.getState().focus).toBe('pile1');
    expect(measureStore.getState().selected).toEqual(['pile1']);
    expect(bench.getState().front).toBe('volumes');
    expect(bench.getState().tabs.some((t) => t.id === 'measure')).toBe(false);
  });
});

describe('openMeasurement (a sidebar row)', () => {
  it('a pile row opens the pile in the Volumes tab', () => {
    openMeasurement('pile1', bench);
    expect(measureStore.getState().focus).toBe('pile1');
    expect(bench.getState().front).toBe('volumes');
  });

  it('a non-pile measurement still goes to Measure', () => {
    openMeasurement('line1', bench);
    expect(measureStore.getState().focus).toBe('line1');
    expect(bench.getState().front).toBe('measure');
  });
});
