// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { followRoadMeasure } from './measureFollow';
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

  it('lets the live Road tab go when unmounted mid-measure', () => {
    const bench = createWorkbenchStore(null);
    const road = roadMeasure();
    const off = followRoadMeasure(road as never, bench);
    road.setState({ measure: { mode: 'line', vertices: [] } });
    expect(bench.getState().liveTools).toBe(1);
    off();
    expect(bench.getState().liveTools).toBe(0);
    expect(bench.getState().tabs.some((t) => t.id === 'road')).toBe(false);
  });
});
