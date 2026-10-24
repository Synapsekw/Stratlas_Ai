// @vitest-environment jsdom
import type { SurveyMeasurement } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followMeasureTool } from '../../workspace/workbench/measureFollow';
import { drawerStore } from '../../workspace/workbench/drawerStore';
import { createWorkbenchStore } from '../../workspace/workbench/workbenchStore';
import { measureStore } from '../measureStore';
import { isPile, openMeasurement, openPile } from './openPile';

const shellState = vi.hoisted(() => ({ rightCollapsed: false }));
vi.mock('../../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false }) },
  jobs: {},
  useShell: () => null,
  shell: { getState: () => shellState },
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
  shellState.rightCollapsed = false;
  drawerStore.getState().close();
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
    // the Project tab (id `measure`) is always there now, but it is not the one in front
    expect(bench.getState().front).not.toBe('measure');
    // the sidebar is open: the tab comes forward, no drawer pops
    expect(drawerStore.getState().opened).toBeNull();
  });

  it('a folded sidebar brings the drawer out with the Volumes tab', () => {
    shellState.rightCollapsed = true;
    openPile('pile1', bench);
    expect(bench.getState().front).toBe('volumes');
    expect(drawerStore.getState().opened).toBe('click');
  });

  it('a sidebar pile row with the sidebar folded brings the drawer out too', () => {
    shellState.rightCollapsed = true;
    openMeasurement('pile1', bench);
    expect(drawerStore.getState().opened).toBe('click');
  });
});

describe('openPile on a kit pile', () => {
  const vol = () => {
    const state = {
      selected: null as string | null,
      select: vi.fn((pile: string | null) => {
        state.selected = pile;
      }),
    };
    return { getState: () => state, state };
  };

  beforeEach(() => {
    const kit: SurveyMeasurement = {
      ...m('kit1', 'volume', 'polygon'),
      origin: { kind: 'kit-pile', pile: 'P01' },
    };
    measureStore.setState({
      file: {
        ...measureStore.getState().file,
        measurements: [...measureStore.getState().file.measurements, kit],
      },
    });
  });

  it('selects the kit pile in the volumetric view too, without flying', () => {
    const v = vol();
    openPile('kit1', bench, v);
    expect(v.state.selected).toBe('P01');
    expect(v.state.select).toHaveBeenCalledWith('P01', { fly: false });
    expect(measureStore.getState().focus).toBe('kit1');
    expect(bench.getState().front).toBe('volumes');
  });

  it('leaves a kit pile already selected alone', () => {
    const v = vol();
    v.state.selected = 'P01';
    openPile('kit1', bench, v);
    expect(v.state.select).not.toHaveBeenCalled();
  });

  it('a pile drawn by hand leaves the volumetric selection as it is', () => {
    const v = vol();
    openPile('pile1', bench, v);
    expect(v.state.select).not.toHaveBeenCalled();
    expect(v.state.selected).toBeNull();
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
