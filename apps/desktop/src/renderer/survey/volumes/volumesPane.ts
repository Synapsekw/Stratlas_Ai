/**
 * Which pane the Volumes tab shows (volumetrics redesign, spec section 6): Inventory, Cut & fill or
 * Materials. The one source of truth for it: the tab's segments, the stage's Show control
 * ("Colour piles by" on Materials), the sidebar's Stockpiles group and the Measure tab's Site
 * materials entry (`openMaterialsPane`) all read and write this store. `stageShow.pane` and
 * `stageShow.setPane` (workspace/StageShow.tsx) delegate here; `materialsDraft` re-exports it.
 */
import { createStore } from 'zustand/vanilla';

/** The Volumes tab's panes (its segment). */
export type VolumesPane = 'inventory' | 'cutFill' | 'materials';

export interface VolumesPaneState {
  pane: VolumesPane;
  setPane(pane: VolumesPane): void;
}

export const volumesPane = createStore<VolumesPaneState>()((set) => ({
  pane: 'inventory',
  setPane: (pane) => {
    set({ pane });
  },
}));
