import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { setIssueEditing } from '../../issueCard/state';
import { createWorkbenchStore, startWorkbenchReset, type WorkbenchState } from './workbenchStore';

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
  setIssueEditing(null);
});

describe('workbench store', () => {
  it('starts with the fixed set, Selection in front', () => {
    const s = createWorkbenchStore(memory()).getState();
    expect(ids(s)).toEqual(['selection', 'issues', 'volumes', 'changes']);
    expect(s.front).toBe('selection');
  });

  it('a started tool takes the front and its tab closes when it stops', () => {
    const store = createWorkbenchStore(memory());
    store.getState().toolStarted('measure');
    expect(store.getState().front).toBe('measure');
    expect(store.getState().openedByTool.has('measure')).toBe(true);
    store.getState().toolStopped('measure');
    expect(ids(store.getState())).not.toContain('measure');
    expect(store.getState().front).toBe('selection');
    expect(store.getState().openedByTool.size).toBe(0);
  });

  it('toolStarted(measure) while an issue is edited keeps issues in front', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('issues');
    setIssueEditing('i1');
    store.getState().toolStarted('measure');
    expect(store.getState().front).toBe('issues');
    expect(store.getState().attention).toBe('measure');
    store.getState().toolStopped('measure');
    expect(store.getState().front).toBe('issues');
    expect(store.getState().attention).toBeNull();
  });

  it('show-it fronts the tab and clears the dot', () => {
    const store = createWorkbenchStore(memory());
    store.getState().open('issues');
    setIssueEditing('i1');
    store.getState().toolStarted('measure');
    store.getState().show('measure');
    expect(store.getState().front).toBe('measure');
    expect(store.getState().attention).toBeNull();
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

  it('a project change resets tabs to the fixed set', () => {
    const store = createWorkbenchStore(memory());
    const stop = startWorkbenchReset(store);
    store.getState().open('display');
    store.getState().toolStarted('measure');
    workspace.setState({ project: { id: 'other', root: '/o', manifest: {} } as never });
    expect(ids(store.getState())).toEqual(['selection', 'issues', 'volumes', 'changes']);
    expect(store.getState().front).toBe('selection');
    stop();
    workspace.setState({ project: null });
  });
});
