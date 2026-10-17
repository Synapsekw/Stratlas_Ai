/**
 * The RF tab in the workbench (stage island R2): open it, optionally on one antenna unit, and
 * start a coverage run as a tool the person started (`toolStarted('rf')`, its tab goes live until
 * the job ends). The entry action (T11) calls `openRfTab`.
 */
import { workbench, type WorkbenchState } from '../workspace/workbench/workbenchStore';
import type { StoreApi } from 'zustand';
import { focusRfUnit, rfStore, startCoverage, type StartResult } from './rfStore';

/** Bring the RF tab to the front (opening it when it is not there), showing `antennaId` if given. */
export function openRfTab(antennaId?: string, bench: StoreApi<WorkbenchState> = workbench): void {
  if (antennaId !== undefined) focusRfUnit(antennaId);
  // open() never duplicates a tab and brings it to the front (show() alone adds no tab)
  bench.getState().open('rf');
}

/**
 * Start a coverage run the person asked for. While the job runs the RF tab is live; when it ends
 * (done, failed or cancelled) the tab stops being live and stays open.
 */
export async function startRfRun(
  root: string,
  bench: StoreApi<WorkbenchState> = workbench,
): Promise<StartResult> {
  const r = await startCoverage(root);
  if (!r.ok) return r;
  bench.getState().toolStarted('rf');
  if (!rfStore.getState().running) {
    bench.getState().toolStopped('rf');
    return r;
  }
  const stop = rfStore.subscribe((s) => {
    if (s.running) return;
    stop();
    bench.getState().toolStopped('rf');
  });
  return r;
}
