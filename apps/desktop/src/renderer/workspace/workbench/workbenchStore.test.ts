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
    removeItem: (k: string) => {
      m.delete(k);
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

  it('drops the old pins once and lands on the new home of the old front tab', () => {
    const storage = memory({
      'quadrion.workbench': JSON.stringify({ pinned: ['measure', 'rf'], front: 'display' }),
    });
    const s = createWorkbenchStore(storage).getState();
    expect(ids(s)).not.toContain('rf');
    expect(s.panel).toBe('layers');
    expect(s.sections['layers.display']).toBe(true);
    expect(storage.getItem('quadrion.workbench')).toBeNull();
    expect(JSON.parse(storage.getItem('quadrion.panel') ?? '{}')).toMatchObject({ tab: 'layers' });
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

  it('remembers the tab and its open sections per computer', () => {
    const storage = memory();
    const a = createWorkbenchStore(storage);
    a.getState().show('project', 'project.jobs');
    const b = createWorkbenchStore(storage).getState();
    expect(b.panel).toBe('project');
    expect(b.sections['project.jobs']).toBe(true);
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

  it('a tool brings its tab forward with its section open; a waiting one moves nothing', () => {
    const store = createWorkbenchStore(memory());
    store.getState().toolStarted('annotate');
    expect(store.getState().panel).toBe('tools');
    expect(store.getState().sections['tools.annotate']).toBe(true);
    store.getState().show('selection');
    beginIssueEdit('a');
    store.getState().toolStarted('rf');
    expect(store.getState().panel).toBe('selection');
    expect(store.getState().attention).toBe('rf');
  });

  it('show(tab, section) opens the section and brings its body forward', () => {
    const store = createWorkbenchStore(memory());
    store.getState().show('layers', 'layers.cutaway');
    expect(store.getState().panel).toBe('layers');
    expect(store.getState().front).toBe('cutaway');
    expect(store.getState().sections['layers.cutaway']).toBe(true);
    // a tab alone keeps a front that is already one of its own
    store.getState().show('layers');
    expect(store.getState().front).toBe('cutaway');
    store.getState().show('project', 'project.inThisProject');
    expect(store.getState().panel).toBe('project');
    expect(store.getState().front).toBe('issues');
    expect(store.getState().sections['project.inThisProject']).toBe(true);
  });

  it('toggleSection opens and closes; opening brings the body forward', () => {
    const store = createWorkbenchStore(memory());
    store.getState().show('tools');
    store.getState().toggleSection('tools.environment');
    expect(store.getState().sections['tools.environment']).toBe(true);
    expect(store.getState().front).toBe('environment');
    store.getState().toggleSection('tools.environment');
    expect(store.getState().sections['tools.environment']).toBe(false);
    expect(store.getState().front).toBe('environment');
  });

  it('opening a tab or a section never changes the width: only Expand panel does', () => {
    const store = createWorkbenchStore(memory());
    store.getState().show('project', 'project.volumes');
    store.getState().show('tools', 'tools.coverage');
    store.getState().toolStarted('thermal');
    expect(store.getState().expanded).toBe(false);
    store.getState().expand(true);
    expect(store.getState().expanded).toBe(true);
    store.getState().reset();
    expect(store.getState().expanded).toBe(false);
  });

  it('Expand panel lets go when its wide section closes or another tab comes forward', () => {
    const store = createWorkbenchStore(memory());
    store.getState().show('tools', 'tools.thermal');
    store.getState().expand(true);
    expect(store.getState().expanded).toBe(true);
    // the wide section closed: back to the band's width
    store.getState().toggleSection('tools.thermal');
    expect(store.getState().expanded).toBe(false);
    // pressed again, then another tab: back to the band's width too
    store.getState().toggleSection('tools.thermal');
    store.getState().expand(true);
    store.getState().show('layers');
    expect(store.getState().expanded).toBe(false);
    // Volumes and Changes are wide sections too
    store.getState().show('project', 'project.volumes');
    store.getState().expand(true);
    expect(store.getState().expanded).toBe(true);
  });

  it('another project keeps the person on their tab', () => {
    const store = createWorkbenchStore(memory());
    store.getState().show('layers');
    store.getState().reset();
    expect(store.getState().panel).toBe('layers');
  });

  it('a noted section shows "Show it" until it is shown', () => {
    const store = createWorkbenchStore(memory());
    store.getState().show('layers');
    store.getState().note('project.inThisProject');
    expect(store.getState().noteSection).toBe('project.inThisProject');
    expect(store.getState().panel).toBe('layers');
    store.getState().show('project', 'project.inThisProject');
    expect(store.getState().noteSection).toBeNull();
  });
});
