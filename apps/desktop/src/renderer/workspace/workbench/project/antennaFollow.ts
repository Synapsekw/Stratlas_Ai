// A pick on an antenna in the 3D view follows into the Project list: the unit is selected, its row
// revealed and held open, and the Project tab comes to the front, unless a tool is in front (the
// list then updates in the background, so a pick never takes Coverage away mid-use).
import type { StoreApi } from 'zustand/vanilla';
import { revealAntenna, setAntennaFilter, antennaStore } from '../../../telecom/antennaStore';
import { workbench, type WorkbenchState } from '../workbenchStore';

export function followAntennaPick(id: string, bench: StoreApi<WorkbenchState> = workbench): void {
  const { file, filter } = antennaStore.getState();
  const unit = file?.units.find((u) => u.id === id);
  // a unit the filter hides (a rejected one under To review) is listed: every unit shows
  if (unit && filter !== 'all' && unit.status !== filter) setAntennaFilter('all');
  revealAntenna(id, bench);
}
