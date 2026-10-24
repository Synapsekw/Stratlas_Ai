/**
 * A pile opens in the Volumes tab wherever it is clicked: in 3D, on the Map, in the sidebar's
 * rows or the Inventory (spec section 3, "Opening it"). Every other measurement still brings the
 * Measure tab (`followMeasureTool`).
 */
import type { SurveyMeasurement } from '@aio/schema';
import type { StoreApi } from 'zustand/vanilla';
import { isIssueEditing } from '../../issueCard/state';
import { revealTab } from '../../workspace/workbench/measureFollow';
import { workbench, type WorkbenchState } from '../../workspace/workbench/workbenchStore';
import { measureStore, select } from '../measureStore';
import { pickInVolumesView } from '../volumesPick';

/** A stockpile: a volume measurement drawn as a polygon. */
export function isPile(m: Pick<SurveyMeasurement, 'tool' | 'family'>): boolean {
  return m.tool === 'volume' && m.family === 'polygon';
}

/**
 * Open a pile: select it and bring the Volumes tab forward (unless an issue is being edited, as
 * the Measure tab waits then). The pick is noted first so the Measure tab does not follow it.
 */
export function openPile(id: string, bench: StoreApi<WorkbenchState> = workbench): void {
  pickInVolumesView(id);
  select([id], id);
  if (!isIssueEditing()) revealTab('volumes', bench);
}

/** A measurement row picked: a pile opens in the Volumes tab, anything else is selected. */
export function openMeasurement(id: string, bench: StoreApi<WorkbenchState> = workbench): void {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (m && isPile(m)) openPile(id, bench);
  else select([id], id);
}
