// Right panel state (UI revision D2; stage island D11, D13-D15). The four tabs, which sections are
// open, and under them the old tab ids the tools and benches still speak (`front` is the body a
// tool or an ask last brought forward). The pure rules live in tabsModel; this holds them in a
// store, remembers the tab and its open sections per computer, and reads the issue edit state.
import { workspace, type Workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { isIssueEditing } from '../../issueCard/state';
import { browserStorage } from '../stagePrefs';
import {
  isPanelTab,
  onToolStart,
  onToolStop,
  openPanel,
  orderTabs,
  readPanelPlace,
  sectionDef,
  sectionFor,
  TAB_FRONT,
  tabOfSection,
  type PanelTab,
  type SectionId,
  type Tab,
  type TabId,
  type TabsChange,
} from './tabsModel';

/** Where the panel's tab and open sections are remembered, per computer. */
export const PANEL_KEY = 'quadrion.panel';
/** The old workbench key (pins): read once to land on the old front tab's new home, then gone. */
export const OLD_WORKBENCH_KEY = 'quadrion.workbench';

/** The bodies that are always there; Project's old id (`measure`) first. */
const FIXED: readonly TabId[] = ['measure', 'selection', 'issues', 'volumes', 'changes'];
const fixedTabs = (): Tab[] => FIXED.map((id) => ({ id, live: false, pinned: false, fixed: true }));

export interface WorkbenchState {
  tabs: Tab[];
  /** The body a tool or an ask last brought forward (an old tab id). */
  front: TabId;
  /** The panel tab on screen. */
  panel: PanelTab;
  /** Sections open or closed by the person (or by a tool that brought one forward). */
  sections: Partial<Record<SectionId, boolean>>;
  /** "Expand panel" pressed for a wide tool: the panel opens at its band's widest. */
  expanded: boolean;
  /** A tool tab waiting behind an issue edit (dot plus "Show it"). */
  attention: TabId | null;
  /** Every tool tab waiting behind an issue edit; `attention` is the first. */
  waiting: readonly TabId[];
  /** Tabs a tool created, which close when it stops. */
  openedByTool: Set<TabId>;
  /** Bring a body forward by its old id: its tab in front, its section open. */
  open(id: TabId, opts?: { pinned?: boolean }): void;
  /** Keep a tool's body shown when another tool panel opens (no control on screen sets it). */
  pin(id: TabId, on: boolean): void;
  /** A tool's body is done with (Environment, Clean up, a finished review): it leaves. */
  close(id: TabId): void;
  /**
   * Bring a tab forward: an old id (also the "Show it" action) as `open`, or one of the four
   * panel tabs, with a section to open in it.
   */
  show(target: TabId | PanelTab, section?: SectionId): void;
  /** Open or close one section; opening brings its body forward. */
  toggleSection(id: SectionId): void;
  /** "Expand panel" for a wide tool, and back. Nothing else changes the width. */
  expand(on: boolean): void;
  /**
   * Tools the person started, ever: the drawer opens on a change. Whether one is live now is read
   * from the tabs (`personToolLive`), never counted (I-R63).
   */
  toolSeq: number;
  /** A person's tool starts: its body goes live and comes forward (D14). Again while live: no-op. */
  toolStarted(id: TabId): void;
  /** The tool ends: its body is no longer live, and leaves if the tool opened it. Not live: no-op. */
  toolStopped(id: TabId): void;
  /**
   * An activity goes live (a playing clip, running jobs; I-R62): its body gets its dot, but it
   * takes no front, closes no panel, moves no `toolSeq` and leaves the agent (I-R39, I-R43).
   */
  activityStarted(id: TabId): void;
  /** The activity ends: as `toolStopped`. */
  activityStopped(id: TabId): void;
  reset(): void;
}

const isLive = (s: Pick<WorkbenchState, 'tabs'>, id: TabId): boolean =>
  s.tabs.some((t) => t.id === id && t.live);

/** The tab and open sections once `front` comes forward: its home tab, its section open. */
function placeOf(
  front: TabId,
  sections: WorkbenchState['sections'],
): Pick<WorkbenchState, 'panel' | 'sections'> {
  const home = sectionFor(front);
  if (home.tab === 'selection') return { panel: 'selection', sections };
  return { panel: home.tab, sections: { ...sections, [home.section]: true } };
}

function readItem(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function createWorkbenchStore(
  storage: Storage | null = browserStorage(),
): StoreApi<WorkbenchState> {
  // the old key is read once: its pins are dropped, its front tab mapped to its new home
  const place = readPanelPlace(readItem(storage, PANEL_KEY), readItem(storage, OLD_WORKBENCH_KEY));
  try {
    storage?.removeItem(OLD_WORKBENCH_KEY);
  } catch {
    // blocked storage: it is read again next time, to the same place
  }

  const base = (): Pick<
    WorkbenchState,
    'tabs' | 'front' | 'attention' | 'waiting' | 'openedByTool' | 'expanded'
  > => ({
    tabs: fixedTabs(),
    front: 'selection',
    attention: null,
    waiting: [],
    openedByTool: new Set(),
    expanded: false,
  });

  const store = createStore<WorkbenchState>()((set, get) => {
    const apply = (c: TabsChange, openedByTool: Set<TabId>, waiting: readonly TabId[]) => {
      const s = get();
      set({
        tabs: c.tabs,
        front: c.front,
        waiting,
        attention: waiting[0] ?? null,
        openedByTool,
        // the panel follows the front only when it moved: a tool waiting behind an issue does not
        ...(c.front !== s.front ? placeOf(c.front, s.sections) : {}),
      });
    };
    /** Bring an old id forward: there already, to the front; else opened as a panel. */
    const bring = (id: TabId, pinned: boolean) => {
      const s = get();
      const left = s.waiting.filter((w) => w !== id);
      set({
        tabs: s.tabs.some((t) => t.id === id && !pinned)
          ? s.tabs
          : openPanel(s.tabs, id, { pinned }),
        front: id,
        waiting: left,
        attention: left[0] ?? null,
        ...placeOf(id, s.sections),
      });
    };
    return {
      ...base(),
      panel: place.tab,
      sections: place.open,
      toolSeq: 0,
      open: (id, opts) => {
        bring(id, opts?.pinned ?? false);
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
          const gone = s.front === id;
          return {
            tabs: s.tabs.filter((t) => t.id !== id),
            openedByTool,
            front: gone ? 'selection' : s.front,
            ...(gone ? { panel: 'selection' as const } : {}),
            waiting: s.waiting.filter((w) => w !== id),
            attention: s.waiting.find((w) => w !== id) ?? null,
          };
        });
      },
      show: (target, section) => {
        if (!isPanelTab(target) || target === 'selection') {
          bring(target, false);
          return;
        }
        const body = section ? sectionDef(section)?.body : null;
        if (body) {
          bring(body, false);
          return;
        }
        const s = get();
        // the front stays when it is already one of this tab's; else the tab's own body comes
        const front = sectionFor(s.front).tab === target ? s.front : TAB_FRONT[target];
        if (front !== s.front) bring(front, false);
        set((now) => ({
          panel: target,
          sections:
            section && tabOfSection(section) === target
              ? { ...now.sections, [section]: true }
              : now.sections,
        }));
      },
      toggleSection: (id) => {
        const s = get();
        const open = s.sections[id] !== true;
        set({ sections: { ...s.sections, [id]: open } });
        const body = sectionDef(id)?.body;
        if (open && body && s.front !== body) {
          // opening brings its body forward (the drawer, the island's link and the hints follow)
          const left = s.waiting.filter((w) => w !== body);
          set((now) => ({
            tabs: now.tabs.some((t) => t.id === body)
              ? now.tabs
              : openPanel(now.tabs, body, { pinned: false }),
            front: body,
            waiting: left,
            attention: left[0] ?? null,
          }));
        }
      },
      expand: (on) => {
        if (get().expanded !== on) set({ expanded: on });
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
        // another project: the tools' bodies go, the person's tab and sections stay
        set(base());
      },
    };
  });

  // The tab and its open sections are remembered per computer; nothing else is.
  const json = (s: WorkbenchState) => JSON.stringify({ tab: s.panel, open: s.sections });
  let last = readItem(storage, PANEL_KEY);
  const save = (s: WorkbenchState) => {
    const next = json(s);
    if (next === last) return;
    last = next;
    try {
      storage?.setItem(PANEL_KEY, next);
    } catch {
      // private window or blocked storage: the place is just not remembered
    }
  };
  save(store.getState());
  store.subscribe(save);
  return store;
}

export const workbench = createWorkbenchStore();

export function useWorkbench<T>(selector: (s: WorkbenchState) => T): T {
  return useStore(workbench, selector);
}

/**
 * A live body and its tool end together (D13, D14): the body dropped (closed by its tool's own
 * Done, or when another project opens) stops the tool still `running` (Measure stops drawing,
 * Annotate closes its tools). A tool that stops itself leaves the usual way (`toolStopped`) and is
 * not stopped again. Returns unsubscribe.
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

/** Reset the bodies whenever another project opens (or the project closes). Returns unsubscribe. */
export function startWorkbenchReset(
  target: StoreApi<WorkbenchState> = workbench,
  ws: Pick<StoreApi<Workspace>, 'subscribe'> = workspace,
): () => void {
  return ws.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id) target.getState().reset();
  });
}
