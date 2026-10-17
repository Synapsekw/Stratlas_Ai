// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { shell } from '../../shell';
import { drawerStore } from '../workbench/drawerStore';
import { createWorkbenchStore } from '../workbench/workbenchStore';
import { followRoadMeasure, GROUP_TAB, liveTab, openBenchFromIsland } from './islandBench';

vi.mock('../../issueCard/state', () => ({ isIssueEditing: () => false }));

const memory = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => {
      m.clear();
    },
    key: () => null,
    get length() {
      return m.size;
    },
  };
};

describe('islandBench', () => {
  let bench = createWorkbenchStore(memory());
  beforeEach(() => {
    bench = createWorkbenchStore(memory());
    shell.setState({ rightCollapsed: false });
    drawerStore.getState().close();
  });

  it('has a workbench for every group but View', () => {
    expect(GROUP_TAB.view).toBeNull();
    expect(GROUP_TAB.volumes).toBe('volumes');
    expect(GROUP_TAB.road).toBe('road');
    expect(GROUP_TAB.video).toBe('video');
  });

  it('lives a tool in Measure, a clip in Video, a job in Jobs, the connection nowhere', () => {
    expect(liveTab({ kind: 'tool', label: 'Distance', reading: null })).toBe('measure');
    expect(liveTab({ kind: 'playback', clip: 'c', progress: 0, telemetry: null })).toBe('video');
    expect(liveTab({ kind: 'job', id: 'j', label: 'j', progress: 0, more: 0 })).toBe('jobs');
    expect(liveTab({ kind: 'connection', state: 'offline' })).toBeNull();
  });

  it('opens a tab that is not there as an unpinned panel, and brings one that is to the front', () => {
    openBenchFromIsland('jobs', bench);
    expect(bench.getState().front).toBe('jobs');
    expect(bench.getState().tabs.find((t) => t.id === 'jobs')).toMatchObject({ pinned: false });
    bench.getState().open('video', { pinned: true });
    openBenchFromIsland('jobs', bench);
    openBenchFromIsland('video', bench);
    expect(bench.getState().front).toBe('video');
    expect(bench.getState().tabs.find((t) => t.id === 'video')?.pinned).toBe(true);
  });

  it('leaves a folded right panel folded and opens the drawer for it (I-R40, I-R40a)', () => {
    shell.setState({ rightCollapsed: true });
    openBenchFromIsland('volumes', bench);
    expect(shell.getState().rightCollapsed).toBe(true);
    expect(bench.getState().front).toBe('volumes');
    expect(drawerStore.getState().opened).toBe('click');
  });

  it('does not open the drawer while the right panel shows (guarded on rightCollapsed)', () => {
    openBenchFromIsland('volumes', bench);
    expect(bench.getState().front).toBe('volumes');
    // a stray open here would pop the drawer the next time the sidebar folds
    expect(drawerStore.getState().opened).toBeNull();
  });

  it("makes the Road tab live while the road's measure draws, and closes it after", () => {
    const road = createStore<{ measure: { mode: 'line' | null; vertices: [] } }>()(() => ({
      measure: { mode: null, vertices: [] },
    }));
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
});
