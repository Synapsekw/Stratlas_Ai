/**
 * A pile opens in the Volumes tab wherever it is clicked: in 3D, on the Map, in the sidebar's
 * rows or the Inventory (spec section 3, "Opening it"). Every other measurement still brings the
 * Measure tab (`followMeasureTool`).
 */
import type { SurveyMeasurement } from '@aio/schema';
import { volumetric } from '@aio/volumetric';
import type { StoreApi } from 'zustand/vanilla';
import { isIssueEditing } from '../../issueCard/state';
import { showBench } from '../../workspace/workbench/followTool';
import { workbench, type WorkbenchState } from '../../workspace/workbench/workbenchStore';
import { measureStore, select } from '../measureStore';
import { pickInVolumesView } from '../volumesPick';

/** A stockpile: a volume measurement drawn as a polygon. */
export function isPile(m: Pick<SurveyMeasurement, 'tool' | 'family'>): boolean {
  return m.tool === 'volume' && m.family === 'polygon';
}

/** The volumetric view's pile selection, as `openPile` needs it. */
export interface KitPileSelection {
  getState(): {
    selected: string | null;
    select(pile: string | null, opts?: { fly?: boolean }): void;
  };
}

/**
 * Open a pile: select it and bring the Volumes tab forward so its panel shows (unless an issue is
 * being edited, as the Measure tab waits then). With the sidebar folded the workbench drawer comes
 * out with it, and a maximised agent steps back (`showBench`); an open sidebar only changes tab.
 * The pick is noted first so the Measure tab does not follow it.
 *
 * A pile converted from the kit (`origin: { kind: 'kit-pile' }`) selects its kit pile in the
 * volumetric view too, as a click on the kit pile itself did: its body, toe line and callout show
 * and the workspace selects the pile's asset. Its outline now lies on the pile and takes the click
 * before the pile body, so this is where a 3D click on a kit pile reaches the volumetric view.
 * The camera stays where it is: the pile was clicked in view, or picked from a list that never
 * flew. The volumetric selection comes back here through `connectKitPilePick`, which finds the
 * kit pile already selected and goes no further.
 */
export function openPile(
  id: string,
  bench: StoreApi<WorkbenchState> = workbench,
  vol: KitPileSelection = volumetric,
): void {
  pickInVolumesView(id);
  select([id], id);
  if (!isIssueEditing()) showBench('volumes', bench);
  const origin = measureStore.getState().file.measurements.find((x) => x.id === id)?.origin;
  if (origin?.kind === 'kit-pile' && vol.getState().selected !== origin.pile)
    vol.getState().select(origin.pile, { fly: false });
}

/** A measurement row picked: a pile opens in the Volumes tab, anything else is selected. */
export function openMeasurement(id: string, bench: StoreApi<WorkbenchState> = workbench): void {
  const m = measureStore.getState().file.measurements.find((x) => x.id === id);
  if (m && isPile(m)) openPile(id, bench);
  else select([id], id);
}
