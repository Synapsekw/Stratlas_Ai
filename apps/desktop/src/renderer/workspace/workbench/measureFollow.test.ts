// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { pickInVolumesView } from '../../survey/volumesPick';
import { followMeasureTool, followRoadMeasure } from './measureFollow';
import { personToolLive } from './tabsModel';
import { createWorkbenchStore } from './workbenchStore';

vi.mock('../../issueCard/state', () => ({ isIssueEditing: () => false }));

const roadMeasure = () =>
  createStore<{ measure: { mode: 'line' | null; vertices: [] } }>()(() => ({
    measure: { mode: null, vertices: [] },
  }));

describe('followRoadMeasure', () => {
  it("makes the Road tab live while the road's measure draws, and closes it after", () => {
    const bench = createWorkbenchStore(null);
    const road = roadMeasure();
    const off = followRoadMeasure(road as never, bench);
    road.setState({ measure: { mode: 'line', vertices: [] } });
    expect(bench.getState().front).toBe('road');
    expect(bench.getState().tabs.find((t) => t.id === 'road')?.live).toBe(true);
    // a new point is not a new start
    road.setState({ measure: { mode: 'line', vertices: [] } });
    road.setState({ measure: { mode: null, vertices: [] } });
    expect(bench.getState().tabs.some((t) => t.id === 'road')).toBe(false);
    expect(bench.getState().front).toBe('selection');
    off();
    road.setState({ measure: { mode: 'line', vertices: [] } });
    expect(bench.getState().front).toBe('selection');
  });

  it("closing the live Road tab with its X stops the road's measure", () => {
    const bench = createWorkbenchStore(null);
    const road = roadMeasure();
    const off = followRoadMeasure(road as never, bench, (m) => {
      road.setState({ measure: m as never });
    });
    road.setState({ measure: { mode: 'line', vertices: [] } });
    bench.getState().close('road');
    expect(road.getState().measure.mode).toBeNull();
    expect(bench.getState().tabs.some((t) => t.id === 'road')).toBe(false);
    off();
  });

  it('lets the live Road tab go when unmounted mid-measure', () => {
    const bench = createWorkbenchStore(null);
    const road = roadMeasure();
    const off = followRoadMeasure(road as never, bench);
    road.setState({ measure: { mode: 'line', vertices: [] } });
    expect(personToolLive(bench.getState().tabs)).toBe(true);
    off();
    expect(personToolLive(bench.getState().tabs)).toBe(false);
    expect(bench.getState().tabs.some((t) => t.id === 'road')).toBe(false);
  });
});

describe('followMeasureTool', () => {
  interface Measuring {
    tool: { tool: string } | null;
    focus: string | null;
  }
  const measure = () => createStore<Measuring>()(() => ({ tool: null, focus: null }));

  it('lets the live Measure tab go when the Scene is left mid-drawing, so none stays live', () => {
    const bench = createWorkbenchStore(null);
    const store = measure();
    const off = followMeasureTool(store as never, bench);
    store.setState({ tool: { tool: 'distance' } });
    expect(bench.getState().tabs.find((t) => t.id === 'measure')?.live).toBe(true);
    // the Scene unmounts: the follower goes
    off();
    expect(personToolLive(bench.getState().tabs)).toBe(false);
    // the Project tab is fixed: it stays, no longer live
    expect(bench.getState().tabs.find((t) => t.id === 'measure')?.live).toBe(false);
    // back on the Scene: a new follower, then the mount stops the tool it never saw start
    const again = followMeasureTool(store as never, bench);
    store.setState({ tool: null });
    expect(personToolLive(bench.getState().tabs)).toBe(false);
    // the next tool starts and ends as usual
    store.setState({ tool: { tool: 'distance' } });
    expect(personToolLive(bench.getState().tabs)).toBe(true);
    store.setState({ tool: null });
    expect(personToolLive(bench.getState().tabs)).toBe(false);
    again();
  });

  it("a pile picked in the Volumes view's list stays there; a pick elsewhere brings Measure", () => {
    const bench = createWorkbenchStore(null);
    const store = measure();
    const off = followMeasureTool(store as never, bench);
    bench.getState().show('volumes');
    // the view's own detail card shows the pile
    pickInVolumesView('p1');
    store.setState({ focus: 'p1' });
    expect(bench.getState().front).toBe('volumes');
    // another pile picked in the tree: the Measure tab comes forward, as before
    store.setState({ focus: 'p2' });
    expect(bench.getState().front).toBe('measure');
    off();
  });
});
