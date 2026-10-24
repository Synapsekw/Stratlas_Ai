import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginIssueEdit, clearIssueEditing } from '../../issueCard/state';
import { personToolLive } from './tabsModel';
import {
  createWorkbenchStore,
  linkLiveTab,
  startWorkbenchReset,
  type WorkbenchState,
} from './workbenchStore';

function memory(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  } as unknown as Storage;
}
const ids = (s: WorkbenchState) => s.tabs.map((t) => t.id);

afterEach(() => {
  clearIssueEditing();
});

describe('workbench store', () => {
  it('starts with the fixed set, Project first, Selection in front', () => {
    const s = createWorkbenchStore(memory()).getState();
    expect(ids(s)).toEqual(['measure', 'selection', 'issues', 'volumes', 'changes']);
    expect(s.front).toBe('selection');
  });

  it('a started tool takes the front and its tab closes when it stops', () => {
    const store = createWorkbenchStore(memory());
    store.getState().toolStarted('annotate');
    expect(store.getState().front).toBe('annotate');
    expect(store.getState().openedByTool.has('annotate')).toBe(true);
    store.getState().toolStopped('annotate');
    expect(ids(store.getState())).not.toContain('annotate');
    expect(store.getState().front).toBe('selection');
    expect(store.getState().openedByTool.size).toBe(0);
  });

  it('always has the Project tab', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('display');
    store.getState().reset();
    expect(store.getState().tabs.find((t) => t.id === 'measure')).toMatchObject({
      fixed: true,
      pinned: false,
    });
    // a fixed tab has no close
    store.getState().show('measure');
    store.getState().close('measure');
    expect(ids(store.getState())).toContain('measure');
    expect(store.getState().front).toBe('measure');
  });

  it('ignores a remembered pin of measure', () => {
    const storage = memory({
      'quadrion.workbench': JSON.stringify({ pinned: ['measure', 'rf'] }),
    });
    const s = createWorkbenchStore(storage).getState();
    expect(s.tabs.filter((t) => t.id === 'measure')).toEqual([
      { id: 'measure', live: false, pinned: false, fixed: true },
    ]);
    expect(s.tabs.find((t) => t.id === 'rf')?.pinned).toBe(true);
  });

  it('keeps Project in front after the tool that made it live stops', () => {
    const store = createWorkbenchStore(memory());
    store.getState().toolStarted('measure');
    expect(store.getState().front).toBe('measure');
    expect(store.getState().openedByTool.has('measure')).toBe(false);
    store.getState().toolStopped('measure');
    expect(store.getState().front).toBe('measure');
    expect(store.getState().tabs.find((t) => t.id === 'measure')).toMatchObject({
      live: false,
      fixed: true,
    });
  });

  it('toolStarted(measure) while an issue is edited keeps issues in front', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('issues');
    beginIssueEdit('a');
    store.getState().toolStarted('measure');
    expect(store.getState().front).toBe('issues');
    expect(store.getState().attention).toBe('measure');
    store.getState().toolStopped('measure');
    expect(store.getState().front).toBe('issues');
    expect(store.getState().attention).toBeNull();
  });

  it('a second tool starting keeps the first tool dot', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('issues');
    beginIssueEdit('a');
    store.getState().toolStarted('measure');
    store.getState().toolStarted('display');
    expect(store.getState().front).toBe('issues');
    expect(store.getState().attention).toBe('measure');
    store.getState().show('measure');
    expect(store.getState().attention).toBe('display');
    store.getState().toolStopped('display');
    expect(store.getState().attention).toBeNull();
  });

  it('show-it fronts the tab and clears the dot', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('issues');
    beginIssueEdit('a');
    store.getState().toolStarted('measure');
    store.getState().show('measure');
    expect(store.getState().front).toBe('measure');
    expect(store.getState().attention).toBeNull();
  });

  it('a tool started again while live is one start, and one stop ends it (I-R63)', () => {
    const store = createWorkbenchStore(memory());
    store.getState().toolStarted('annotate');
    const seq = store.getState().toolSeq;
    // a follower mounted again sends the same start
    store.getState().toolStarted('annotate');
    expect(store.getState().toolSeq).toBe(seq);
    expect(personToolLive(store.getState().tabs)).toBe(true);
    store.getState().toolStopped('annotate');
    expect(personToolLive(store.getState().tabs)).toBe(false);
    expect(ids(store.getState())).not.toContain('annotate');
    // a stop with nothing live changes nothing
    store.getState().open('display');
    store.getState().toolStopped('display');
    expect(ids(store.getState())).toContain('display');
  });

  it('an activity goes live without taking the front or counting as a tool start (I-R62)', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('display');
    store.getState().activityStarted('video');
    const s = store.getState();
    expect(s.tabs.find((t) => t.id === 'video')?.live).toBe(true);
    expect(s.front).toBe('display');
    expect(ids(s)).toContain('display');
    expect(s.toolSeq).toBe(0);
    expect(personToolLive(s.tabs)).toBe(false);
    store.getState().activityStarted('video');
    expect(store.getState().tabs.filter((t) => t.id === 'video')).toHaveLength(1);
    store.getState().activityStopped('video');
    expect(ids(store.getState())).not.toContain('video');
    expect(store.getState().front).toBe('display');
  });

  it('an activity whose tab the person had open leaves it open, no longer live', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('jobs');
    store.getState().activityStarted('jobs');
    expect(store.getState().front).toBe('jobs');
    store.getState().activityStopped('jobs');
    expect(store.getState().tabs.find((t) => t.id === 'jobs')?.live).toBe(false);
    expect(store.getState().front).toBe('jobs');
  });

  it('pins persist per computer and close unpins', () => {
    const storage = memory();
    const a = createWorkbenchStore(storage);
    a.getState().open('display', { pinned: true });
    const b = createWorkbenchStore(storage);
    expect(b.getState().tabs.find((t) => t.id === 'display')?.pinned).toBe(true);
    b.getState().close('display');
    expect(ids(b.getState())).not.toContain('display');
    expect(ids(createWorkbenchStore(storage).getState())).not.toContain('display');
  });

  it('drops a remembered pin of a tab that is gone (the old Measurements list)', () => {
    const storage = memory({
      'quadrion.workbench': JSON.stringify({ pinned: ['measurements', 'video', 7] }),
    });
    const tabs = ids(createWorkbenchStore(storage).getState());
    expect(tabs).toContain('video');
    expect(tabs).not.toContain('measurements');
  });

  it('pin(id, on) toggles a panel pin', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('display');
    store.getState().pin('display', true);
    expect(store.getState().tabs.find((t) => t.id === 'display')?.pinned).toBe(true);
    store.getState().pin('display', false);
    expect(store.getState().tabs.find((t) => t.id === 'display')?.pinned).toBe(false);
  });

  it('survives blocked storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const store = createWorkbenchStore(blocked);
    store.getState().open('display', { pinned: true });
    expect(ids(store.getState())).toContain('display');
  });

  it('a live tab closed with its X stops its tool (D14: closing returns to Selection)', () => {
    const store = createWorkbenchStore(memory());
    let running = true;
    const stop = vi.fn(() => {
      running = false;
    });
    const off = linkLiveTab('annotate', () => running, stop, store);
    store.getState().toolStarted('annotate');
    store.getState().close('annotate');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(store.getState().front).toBe('selection');
    expect(store.getState().openedByTool.has('annotate')).toBe(false);
    off();
  });

  it('a tool that stops itself is not stopped again, and a bench tab closed stops nothing', () => {
    const store = createWorkbenchStore(memory());
    let running = true;
    const stop = vi.fn();
    const off = linkLiveTab('annotate', () => running, stop, store);
    store.getState().toolStarted('annotate');
    running = false;
    store.getState().toolStopped('annotate');
    expect(ids(store.getState())).not.toContain('annotate');
    store.getState().open('annotate');
    running = true;
    store.getState().close('annotate');
    expect(stop).not.toHaveBeenCalled();
    off();
  });

  it('a project change stops the live tools with their tabs', () => {
    const store = createWorkbenchStore(memory());
    const stopReset = startWorkbenchReset(store);
    const stop = vi.fn();
    const off = linkLiveTab('annotate', () => true, stop, store);
    store.getState().toolStarted('annotate');
    workspace.setState({ project: { id: 'another', root: '/a', manifest: {} } as never });
    expect(stop).toHaveBeenCalledTimes(1);
    off();
    stopReset();
    workspace.setState({ project: null });
  });

  it('a project change resets tabs to the fixed set', () => {
    const store = createWorkbenchStore(memory());
    const stop = startWorkbenchReset(store);
    store.getState().open('display');
    store.getState().toolStarted('measure');
    workspace.setState({ project: { id: 'other', root: '/o', manifest: {} } as never });
    expect(ids(store.getState())).toEqual(['measure', 'selection', 'issues', 'volumes', 'changes']);
    expect(store.getState().front).toBe('selection');
    stop();
    workspace.setState({ project: null });
  });
});
