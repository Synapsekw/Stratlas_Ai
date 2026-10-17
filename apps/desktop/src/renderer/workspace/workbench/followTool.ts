/**
 * How a tool or an ask brings its sidebar tab forward (stage island D13, D14): one rule for every
 * bench, so the drawer (Task 19) can follow the same one.
 * - A tool that starts (M, A, an island tile: the default) goes live through `toolStarted`: its
 *   tab takes the front, unless an issue is being edited, where it waits with a dot and "Show it".
 * - An explicit ask for a panel (`ask`: the layer menu, the palette, the island's Measure tab, the
 *   cloud colours, Clean up) opens it in front, an issue in edit or not: the person asked for it
 *   now, by name.
 * - `unfold`: what has its controls only in the sidebar unfolds a folded sidebar (Annotate, the
 *   asks above). A drawing tool whose work is on the stage does not (M: the drawing and its keys
 *   are the stage's, and the folded sidebar's Save is the stage's `UnsavedBar`).
 * The road tools have no tab: their controls are on the stage (the measure bar, the close-up).
 */
import type { StoreApi } from 'zustand/vanilla';
import { shell } from '../../shell';
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
