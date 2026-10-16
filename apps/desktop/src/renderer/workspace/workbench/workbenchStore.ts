// Right-sidebar workbench state (stage island D11, D13-D15). The pure rules live in tabsModel;
// this holds them in a store, remembers pins per computer, and reads the issue edit state.
import { workspace, type Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { isIssueEditing } from '../../issueCard/state';
import { browserStorage } from '../stagePrefs';
import {
  onToolStart,
  onToolStop,
  openPanel,
  orderTabs,
  type Tab,
  type TabId,
  type TabsChange,
} from './tabsModel';

const KEY = 'quadrion.workbench';

const FIXED: readonly TabId[] = ['selection', 'issues', 'volumes', 'changes'];
const fixedTabs = (): Tab[] => FIXED.map((id) => ({ id, live: false, pinned: false, fixed: true }));

export interface WorkbenchState {
  tabs: Tab[];
  front: TabId;
  /** A tool tab waiting behind an issue edit (dot plus "Show it"). */
  attention: TabId | null;
  /** Tabs a tool created, which close when it stops. */
  openedByTool: Set<TabId>;
  open(id: TabId, opts?: { pinned?: boolean }): void;
  pin(id: TabId, on: boolean): void;
  close(id: TabId): void;
  /** Bring a tab to the front (also the "Show it" action). */
  show(id: TabId): void;
  toolStarted(id: TabId): void;
  toolStopped(id: TabId): void;
  reset(): void;
}

function readPins(storage: Storage | null): TabId[] {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? 'null') as unknown;
    const raw = (v as { pinned?: unknown } | null)?.pinned;
    return Array.isArray(raw) ? (raw.filter((x) => typeof x === 'string') as TabId[]) : [];
  } catch {
    return [];
  }
}

export function createWorkbenchStore(
  storage: Storage | null = browserStorage(),
): StoreApi<WorkbenchState> {
  const base = (): Pick<WorkbenchState, 'tabs' | 'front' | 'attention' | 'openedByTool'> => {
    let tabs = fixedTabs();
    for (const id of readPins(storage)) {
      if (!FIXED.includes(id)) tabs = openPanel(tabs, id, { pinned: true });
    }
    return { tabs, front: 'selection', attention: null, openedByTool: new Set() };
  };

  const store = createStore<WorkbenchState>()((set, get) => {
    const apply = (c: TabsChange, openedByTool: Set<TabId>) => {
      set({ tabs: c.tabs, front: c.front, attention: c.attention, openedByTool });
    };
    return {
      ...base(),
      open: (id, opts) => {
        const { tabs, attention } = get();
        set({
          tabs: openPanel(tabs, id, { pinned: opts?.pinned ?? false }),
          front: id,
          attention: attention === id ? null : attention,
        });
      },
      pin: (id, on) => {
        set((s) => ({
          tabs: orderTabs(s.tabs.map((t) => (t.id === id && !t.fixed ? { ...t, pinned: on } : t))),
        }));
      },
      close: (id) => {
        set((s) => {
          if (s.tabs.find((t) => t.id === id)?.fixed) return {};
          return {
            tabs: s.tabs.filter((t) => t.id !== id),
            front: s.front === id ? 'selection' : s.front,
            attention: s.attention === id ? null : s.attention,
          };
        });
      },
      show: (id) => {
        set((s) => ({ front: id, attention: s.attention === id ? null : s.attention }));
      },
      toolStarted: (id) => {
        const s = get();
        const opened = new Set(s.openedByTool);
        if (!s.tabs.some((t) => t.id === id)) opened.add(id);
        apply(onToolStart({ ...s, issueEditing: isIssueEditing() }, id), opened);
      },
      toolStopped: (id) => {
        const s = get();
        const opened = new Set(s.openedByTool);
        const openedByTool = opened.delete(id);
        apply(onToolStop({ ...s, issueEditing: isIssueEditing() }, id, { openedByTool }), opened);
      },
      reset: () => {
        set(base());
      },
    };
  });

  // Pins are remembered per computer; nothing else is.
  let last = JSON.stringify({ pinned: readPins(storage) });
  store.subscribe((s) => {
    const pinned = s.tabs.filter((t) => t.pinned && !t.fixed).map((t) => t.id);
    const json = JSON.stringify({ pinned });
    if (json === last) return;
    last = json;
    try {
      storage?.setItem(KEY, json);
    } catch {
      // private window or blocked storage: the pins are just not remembered
    }
  });
  return store;
}

export const workbench = createWorkbenchStore();

export function useWorkbench<T>(selector: (s: WorkbenchState) => T): T {
  return useStore(workbench, selector);
}

/** Reset the tabs whenever another project opens (or the project closes). Returns unsubscribe. */
export function startWorkbenchReset(
  target: StoreApi<WorkbenchState> = workbench,
  ws: Pick<StoreApi<Workspace>, 'subscribe'> = workspace,
): () => void {
  return ws.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id) target.getState().reset();
  });
}
