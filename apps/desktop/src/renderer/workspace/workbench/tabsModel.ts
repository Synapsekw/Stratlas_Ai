// Pure model of the right-sidebar workbench tabs (stage island D11, D13-D15, D17).
// No React, no DOM: the Tabs part renders what this decides.

/** Every workbench tab, in no particular order (the row's order is decided below). */
export const TAB_IDS = [
  'measure',
  'display',
  'clouds',
  'volumes',
  'video',
  'road',
  'annotate',
  'jobs',
  'selection',
  'issues',
  'changes',
  'qa',
  'overlays',
  'hydro',
  'cleanup',
  // Road, Volumes and environment benches
  'environment',
  'cutaway',
] as const;

export type TabId = (typeof TAB_IDS)[number];

/** A known tab id: a remembered pin of a tab that is gone (the old Measurements list) is not. */
export function isTabId(x: unknown): x is TabId {
  return typeof x === 'string' && (TAB_IDS as readonly string[]).includes(x);
}

export interface Tab {
  id: TabId;
  live: boolean;
  pinned: boolean;
  fixed: boolean;
  minWidth?: number;
}

export interface TabsState {
  tabs: Tab[];
  front: TabId;
  issueEditing: boolean;
  /** A tool tab waiting behind an issue edit (dot plus "Show it"); optional. */
  attention?: TabId | null;
}

export interface TabsChange {
  tabs: Tab[];
  front: TabId;
  /** A tab that wants a dot and a "Show it" action instead of taking the front. */
  attention: TabId | null;
}

/** Fixed tabs sit at the end of the row in this order (D11). */
const FIXED_ORDER: readonly TabId[] = ['selection', 'issues', 'volumes', 'changes'];

const fixedRank = (id: TabId): number => {
  const i = FIXED_ORDER.indexOf(id);
  return i < 0 ? FIXED_ORDER.length : i;
};

/** Live tabs follow the island priority: a live tool, then playback, then jobs. */
const liveRank = (id: TabId): number => (id === 'jobs' ? 2 : id === 'video' ? 1 : 0);

const isUnpinnedPanel = (t: Tab): boolean => !t.fixed && !t.live && !t.pinned;

export function orderTabs(tabs: readonly Tab[]): Tab[] {
  const live = tabs.filter((t) => t.live).sort((a, b) => liveRank(a.id) - liveRank(b.id));
  const panels = tabs.filter((t) => !t.live && !t.fixed);
  const fixed = tabs
    .filter((t) => !t.live && t.fixed)
    .sort((a, b) => fixedRank(a.id) - fixedRank(b.id));
  return [...live, ...panels, ...fixed];
}

/** Opens a workbench (the caller sets the front; pinning a fixed tab is ignored) or tool panel. An unpinned panel replaces the previous unpinned one (D15). */
export function openPanel(tabs: readonly Tab[], id: TabId, { pinned }: { pinned: boolean }): Tab[] {
  const existing = tabs.find((t) => t.id === id);
  if (existing) {
    // Reopening never duplicates; asking to pin pins, but never unpins.
    return orderTabs(
      tabs.map((t) => (t.id === id && !t.fixed ? { ...t, pinned: t.pinned || pinned } : t)),
    );
  }
  const kept = tabs.filter((t) => !isUnpinnedPanel(t));
  return orderTabs([...kept, { id, live: false, pinned, fixed: false }]);
}

/** A tool starts: unpinned panels close, its tab goes live and takes the front unless an issue is edited (D14). */
export function onToolStart(state: TabsState, id: TabId): TabsChange {
  const kept = state.tabs.filter((t) => t.id === id || !isUnpinnedPanel(t));
  const tabs = kept.some((t) => t.id === id)
    ? kept.map((t) => (t.id === id ? { ...t, live: true } : t))
    : [...kept, { id, live: true, pinned: false, fixed: false }];
  const front = tabs.some((t) => t.id === state.front) ? state.front : 'selection';
  return state.issueEditing
    ? { tabs: orderTabs(tabs), front, attention: id }
    : { tabs: orderTabs(tabs), front: id, attention: null };
}

/**
 * A tool stops (D13). When the tool opened its tab, the tab closes and the front returns to
 * Selection (only if the stopped tab was in front); otherwise the bench stays, no longer live.
 */
export function onToolStop(
  state: TabsState,
  id: TabId,
  { openedByTool }: { openedByTool: boolean },
): TabsChange {
  const attention = state.attention === id ? null : (state.attention ?? null);
  const stopped = state.tabs.map((t) => (t.id === id ? { ...t, live: false } : t));
  if (!openedByTool) return { tabs: orderTabs(stopped), front: state.front, attention };
  const tabs = stopped.filter((t) => t.id !== id || t.fixed);
  return {
    tabs: orderTabs(tabs),
    front: state.front === id ? 'selection' : state.front,
    // another tool's pending dot stays
    attention,
  };
}

/**
 * The `overflowOrder` for the foundation `Tabs` part (higher value leaves first; Tabs never
 * drops the selected tab): fixed tabs leave first, then panels, then Selection, live tabs last.
 * Within a group the later tab leaves first. Unknown ids get 0.
 */
export function overflowOrderFor(state: Pick<TabsState, 'tabs'>): (id: TabId) => number {
  const ordered = orderTabs(state.tabs);
  const group = (t: Tab): number => {
    if (t.live) return 0;
    if (t.id === 'selection') return 1;
    return t.fixed ? 3 : 2;
  };
  const order = new Map(ordered.map((t, index) => [t.id, group(t) * 100 + index]));
  return (id) => order.get(id) ?? 0;
}

/**
 * Pane width: the preference raised to the front tab's minimum (D17), then clamped so the stage
 * keeps `stageMin`. `available` is the width shared by stage AND pane (not the room left for the
 * pane). A result below `front.minWidth` means the stage floor won: chrome (rail, margins) must
 * give way first, or the tab is shown cramped.
 */
export function paneWidth(pref: number, front: Tab, stageMin: number, available: number): number {
  const wanted = Math.max(pref, front.minWidth ?? 0);
  return Math.max(0, Math.min(wanted, available - stageMin));
}
