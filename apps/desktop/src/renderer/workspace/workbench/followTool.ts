/**
 * How a tool or an ask brings its sidebar tab forward (stage island D13, D14): one rule for every
 * bench, so the drawer (Task 19) can follow the same one.
 * - A tool that starts (M, A, an island tile: the default) goes live through `toolStarted`: its
 *   tab takes the front, unless an issue is being edited, where it waits with a dot and "Show it".
 * - An explicit ask for a panel (`ask`: the layer menu, the palette, the island's Measure tab, the
 *   cloud colours, Clean up) opens it in front, an issue in edit or not: the person asked for it
 *   now, by name.
 * - `unfold`: an ask from outside the stage (the layer menu, the palette's cloud colours, Clean up)
 *   unfolds a folded sidebar. A tool start never does: with the sidebar folded the workbench
 *   drawer slides in for it (D20, I-R39), and M's folded Save is the stage's `UnsavedBar`.
 * - `showBench`: an open the person makes from the stage (the island, its tiles, Annotate) brings
 *   the tab forward and, with the sidebar folded, opens the drawer instead (I-R40, I-R40a).
 * The road tools have no tab: their controls are on the stage (the measure bar, the close-up).
 */
import type { StoreApi } from 'zustand/vanilla';
import { shell } from '../../shell';
import { openDrawer } from './drawerStore';
import type { TabId } from './tabsModel';
import { workbench, type WorkbenchState } from './workbenchStore';

export interface FollowToolOptions {
  /** An explicit ask: open the tab in front even while an issue is edited. */
  ask?: boolean;
  /** Unfold a folded sidebar first. */
  unfold?: boolean;
}

export function followTool(
  id: TabId,
  { ask = false, unfold = false }: FollowToolOptions = {},
  bench: StoreApi<WorkbenchState> = workbench,
): void {
  if (unfold && shell.getState().rightCollapsed) shell.getState().setRight(false);
  if (ask) bench.getState().open(id);
  else bench.getState().toolStarted(id);
}

/**
 * The person opens a tab from the stage: it comes to the front of the workbench, opened as an
 * unpinned panel (D15) when it is not there yet. A folded sidebar stays folded and the tab shows
 * in the workbench drawer (I-R40a); `show` alone never pops the drawer, so focus-follow does not.
 */
export function showBench(
  id: TabId,
  bench: StoreApi<WorkbenchState> = workbench,
  sh: Pick<typeof shell, 'getState'> = shell,
): void {
  const b = bench.getState();
  if (b.tabs.some((t) => t.id === id)) b.show(id);
  else b.open(id);
  if (sh.getState().rightCollapsed) openDrawer();
}
