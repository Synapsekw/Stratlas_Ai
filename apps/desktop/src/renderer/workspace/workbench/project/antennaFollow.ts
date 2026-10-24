// A pick on an antenna in the 3D view follows into the Project list: the unit is selected, its row
// revealed and held open, and the Project tab comes to the front, unless a tool is in front (the
// list then updates in the background, so a pick never takes Coverage away mid-use). A pick leaves
// a folded sidebar folded; the explicit asks (review links, Edit azimuth) open its drawer, which
// this module registers with the store as `showBench`.
import type { StoreApi } from 'zustand/vanilla';
import { revealAntenna, setShowProject } from '../../../telecom/antennaStore';
import { showBench } from '../followTool';
import { workbench, type WorkbenchState } from '../workbenchStore';

setShowProject((bench) => {
  showBench('measure', bench);
});

export function followAntennaPick(id: string, bench: StoreApi<WorkbenchState> = workbench): void {
  revealAntenna(id, bench);
}
