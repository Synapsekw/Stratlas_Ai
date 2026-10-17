// Right-sidebar workbench state (stage island D11, D13-D15). The pure rules live in tabsModel;
// this holds them in a store, remembers pins per computer, and reads the issue edit state.
import { workspace, type Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { isIssueEditing } from '../../issueCard/state';
import { browserStorage } from '../stagePrefs';
import {
  isTabId,
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
/** Volumes and Changes open at least this wide (D17, founder 16 Oct). */
export const WIDE_TAB_PX = 470;
const fixedTabs = (): Tab[] =>
  FIXED.map((id) => ({
    id,
    live: false,
    pinned: false,
    fixed: true,
    ...(id === 'volumes' || id === 'changes' ? { minWidth: WIDE_TAB_PX } : {}),
  }));

export interface WorkbenchState {
  tabs: Tab[];
  front: TabId;
  /** A tool tab waiting behind an issue edit (dot plus "Show it"). */
  attention: TabId | null;
  /** Every tool tab waiting behind an issue edit; `attention` is the first. */
  waiting: readonly TabId[];
  /** Tabs a tool created, which close when it stops. */
  openedByTool: Set<TabId>;
  open(id: TabId, opts?: { pinned?: boolean }): void;
  pin(id: TabId, on: boolean): void;
  close(id: TabId): void;
  /** Bring a tab to the front (also the "Show it" action). */
  show(id: TabId): void;
  /**
   * Tools the person started, ever: the drawer opens on a change. Whether one is live now is read
   * from the tabs (`personToolLive`), never counted (I-R63).
   */
  toolSeq: number;
  /** A person's tool starts: its tab goes live and takes the front (D14). Again while live: no-op. */
  toolStarted(id: TabId): void;
  /** The tool ends: its tab is no longer live, and closes if the tool opened it. Not live: no-op. */
  toolStopped(id: TabId): void;
  /**
   * An activity goes live (a playing clip, running jobs; I-R62): its tab gets its dot, but it
   * takes no front, closes no panel, moves no `toolSeq` and leaves the agent (I-R39, I-R43).
   */
  activityStarted(id: TabId): void;
  /** The activity ends: as `toolStopped`. */
  activityStopped(id: TabId): void;
  reset(): void;
}

const isLive = (s: Pick<WorkbenchState, 'tabs'>, id: TabId): boolean =>
  s.tabs.some((t) => t.id === id && t.live);

function readPins(storage: Storage | null): TabId[] {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? 'null') as unknown;
    const raw = (v as { pinned?: unknown } | null)?.pinned;
    return Array.isArray(raw) ? raw.filter(isTabId) : [];
  } catch {
    return [];
  }
}

export function createWorkbenchStore(
  storage: Storage | null = browserStorage(),
): StoreApi<WorkbenchState> {
  const base = (): Pick<
    WorkbenchState,
    'tabs' | 'front' | 'attention' | 'waiting' | 'openedByTool'
  > => {
    let tabs = fixedTabs();
    for (const id of readPins(storage)) {
      if (!FIXED.includes(id)) tabs = openPanel(tabs, id, { pinned: true });
    }
    return { tabs, front: 'selection', attention: null, waiting: [], openedByTool: new Set() };
  };

  const store = createStore<WorkbenchState>()((set, get) => {
    const apply = (c: TabsChange, openedByTool: Set<TabId>, waiting: readonly TabId[]) => {
      set({ tabs: c.tabs, front: c.front, waiting, attention: waiting[0] ?? null, openedByTool });
    };
    return {
      ...base(),
      toolSeq: 0,
      open: (id, opts) => {
        const { tabs, waiting } = get();
        const left = waiting.filter((w) => w !== id);
        set({
          tabs: openPanel(tabs, id, { pinned: opts?.pinned ?? false }),
          front: id,
          waiting: left,
          attention: left[0] ?? null,
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
          const openedByTool = new Set(s.openedByTool);
          openedByTool.delete(id);
          return {
            tabs: s.tabs.filter((t) => t.id !== id),
            openedByTool,
            front: s.front === id ? 'selection' : s.front,
            waiting: s.waiting.filter((w) => w !== id),
            attention: s.waiting.find((w) => w !== id) ?? null,
          };
        });
      },
      show: (id) => {
        set((s) => {
          const left = s.waiting.filter((w) => w !== id);
          return { front: id, waiting: left, attention: left[0] ?? null };
        });
      },
      toolStarted: (id) => {
        const s = get();
        // a follower mounted again (the Scene left and come back to) starts nothing twice
        if (isLive(s, id)) return;
        set({ toolSeq: s.toolSeq + 1 });
        const opened = new Set(s.openedByTool);
        if (!s.tabs.some((t) => t.id === id)) opened.add(id);
        const c = onToolStart({ ...s, issueEditing: isIssueEditing() }, id);
        const waiting = c.attention && !s.waiting.includes(id) ? [...s.waiting, id] : s.waiting;
        apply(c, opened, waiting);
      },
      toolStopped: (id) => {
        const s = get();
        if (!isLive(s, id)) return;
        const opened = new Set(s.openedByTool);
        const openedByTool = opened.delete(id);
        const c = onToolStop({ ...s, issueEditing: isIssueEditing() }, id, { openedByTool });
        apply(
          c,
          opened,
          s.waiting.filter((w) => w !== id),
        );
      },
      activityStarted: (id) => {
        const s = get();
        if (isLive(s, id)) return;
        const opened = new Set(s.openedByTool);
        const has = s.tabs.some((t) => t.id === id);
        if (!has) opened.add(id);
        const tabs = has
          ? s.tabs.map((t) => (t.id === id ? { ...t, live: true } : t))
          : [...s.tabs, { id, live: true, pinned: false, fixed: false }];
        set({ tabs: orderTabs(tabs), openedByTool: opened });
      },
      activityStopped: (id) => {
        get().toolStopped(id);
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

/**
 * A live tab and its tool end together (D13, D14): the tab closed with its X, or dropped when
 * another project opens, stops the tool still `running` (Measure stops drawing, Annotate closes
 * its tools), as closing a panel's tab closes the panel. A tool that stops itself closes its tab
 * the usual way (`toolStopped`) and is not stopped again. Returns unsubscribe.
 */
export function linkLiveTab(
  id: TabId,
  running: () => boolean,
  stop: () => void,
  bench: StoreApi<WorkbenchState> = workbench,
): () => void {
  return bench.subscribe((s, prev) => {
    const was = prev.tabs.find((t) => t.id === id);
    if (was?.live && !s.tabs.some((t) => t.id === id) && running()) stop();
  });
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
