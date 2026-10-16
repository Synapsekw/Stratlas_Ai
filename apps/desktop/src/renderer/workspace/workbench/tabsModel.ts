// Pure model of the right-sidebar workbench tabs (stage island D11, D13-D15, D17).
// No React, no DOM: the Tabs part renders what this decides.

export type TabId =
  | 'measure'
  | 'display'
  | 'clouds'
  | 'volumes'
  | 'video'
  | 'road'
  | 'annotate'
  | 'jobs'
  | 'selection'
  | 'issues'
  | 'changes'
  | 'qa'
  | 'overlays'
  | 'hydro'
  | 'cleanup'
  | 'measurements';

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

/** Opens a workbench or tool panel. An unpinned panel replaces the previous unpinned one (D15). */
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
  return state.issueEditing
    ? { tabs: orderTabs(tabs), front: state.front, attention: id }
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
  const stopped = state.tabs.map((t) => (t.id === id ? { ...t, live: false } : t));
  if (!openedByTool) return { tabs: orderTabs(stopped), front: state.front, attention: null };
  const tabs = stopped.filter((t) => t.id !== id || t.fixed);
  return {
    tabs: orderTabs(tabs),
    front: state.front === id ? 'selection' : state.front,
    attention: null,
  };
}

/** Lower leaves the row first: fixed tabs, then panels, then Selection, live last. */
const overflowRank = (t: Tab): number => {
  if (t.live) return 3;
  if (t.id === 'selection') return 2;
  return t.fixed ? 0 : 1;
};

/**
 * One row: tabs leave until the rest fit `available`. Within a rank the later tab leaves first;
 * the front tab never does. Tabs missing from `widths` count as 0. Both lists keep `ordered` order.
 */
export function fitTabs(
  widths: ReadonlyMap<TabId, number>,
  ordered: readonly Tab[],
  front: TabId,
  available: number,
): { shown: TabId[]; overflow: TabId[] } {
  const hidden = new Set<TabId>();
  const width = (t: Tab) => widths.get(t.id) ?? 0;
  let total = ordered.reduce((sum, t) => sum + width(t), 0);
  const leaving = ordered
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => t.id !== front)
    .sort((a, b) => overflowRank(a.t) - overflowRank(b.t) || b.index - a.index);
  for (const { t } of leaving) {
    if (total <= available) break;
    hidden.add(t.id);
    total -= width(t);
  }
  return {
    shown: ordered.filter((t) => !hidden.has(t.id)).map((t) => t.id),
    overflow: ordered.filter((t) => hidden.has(t.id)).map((t) => t.id),
  };
}

/**
 * Pane width: the preference raised to the front tab's minimum (D17), then clamped so the stage
 * keeps `stageMin`. `available` is the width shared by stage and pane.
 */
export function paneWidth(pref: number, front: Tab, stageMin: number, available: number): number {
  const wanted = Math.max(pref, front.minWidth ?? 0);
  return Math.max(0, Math.min(wanted, available - stageMin));
}
