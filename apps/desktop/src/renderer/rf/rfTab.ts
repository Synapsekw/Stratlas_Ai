/**
 * The RF tab in the workbench (stage island R2): open it, optionally on one antenna unit, and
 * start a coverage run, which keeps the tab open while the Jobs tab follows the job (review I2).
 * The entry action (T11) calls `openRfTab`.
 */
import { workbench, type WorkbenchState } from '../workspace/workbench/workbenchStore';
import type { StoreApi } from 'zustand';
import { focusRfUnit, startCoverage, type StartResult } from './rfStore';

// TODO(antenna-detection merge 2): pass Edit RF… to AntennaInventory extra actions
// TODO(stage-3): Coverage tile in the island Measure group
/**
 * Open the Coverage tab (spec F1: the stage chip, Ctrl+K, the project menu), pinned when it opens,
 * so the next panel opened does not replace it. A tab already open only comes to the front: its
 * pin is left as it is, so a person who unpinned Coverage is never overruled (by a run, a review
 * or another open).
 */
export function openCoverage(bench: StoreApi<WorkbenchState> = workbench): void {
  const wb = bench.getState();
  wb.open('rf', wb.tabs.some((x) => x.id === 'rf') ? undefined : { pinned: true });
}

/** Bring the RF tab to the front (opening it pinned), showing `antennaId` if given. */
export function openRfTab(antennaId?: string, bench: StoreApi<WorkbenchState> = workbench): void {
  if (antennaId !== undefined) focusRfUnit(antennaId);
  openCoverage(bench);
}

/**
 * Start a coverage run the person asked for. The run is an activity, not a tool the person holds
 * (integration review I2, I-R62): the RF tab is opened (pinned when new) or kept, and the Jobs
 * follower shows the job live. No `toolStarted`, so the drawer does not open, other panels stay
 * and the agent pane is left as it is while the job runs; closing the RF tab does not cancel it.
 */
export async function startRfRun(
  root: string,
  bench: StoreApi<WorkbenchState> = workbench,
): Promise<StartResult> {
  const r = await startCoverage(root);
  if (r.ok) openCoverage(bench);
  return r;
}
