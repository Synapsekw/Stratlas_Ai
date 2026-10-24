/**
 * The delete question for antennas: which units, which RF sectors hold them, and the flow after a
 * yes (delete from the inventory, then take them out of the coverage plan). The dialog
 * (`AntennaDeleteDialog`) shows `useAntennaDelete`.
 */
import { createStore, useStore } from 'zustand';
import { removeAntennasFromPlan, rfStore } from '../rf/rfStore';
import { antennaStore, deleteBlockedReason, deleteUnits } from './antennaStore';

export interface SectorHold {
  unitId: string;
  unitName: string;
  sector: string;
}

export interface AntennaDeleteAsk {
  ids: string[];
  names: string[];
  sectors: SectorHold[];
  /** The coverage plan has edits not saved yet: the removal goes into the copy only. */
  planUnsaved: boolean;
}

interface DeleteState {
  ask: AntennaDeleteAsk | null;
  busy: boolean;
}

export const antennaDeleteStore = createStore<DeleteState>()(() => ({ ask: null, busy: false }));

export function useAntennaDelete<T>(selector: (s: DeleteState) => T): T {
  return useStore(antennaDeleteStore, selector);
}

/** The saved sectors that hold any of `ids` (only when the coverage plan is of the open project). */
export function sectorsHolding(ids: readonly string[]): SectorHold[] {
  const rf = rfStore.getState();
  const { projectId, file } = antennaStore.getState();
  if (!rf.hasFile || rf.projectId === null || rf.projectId !== projectId) return [];
  const out: SectorHold[] = [];
  for (const id of ids) {
    const sector = rf.sectors.sectors.find((s) => s.antennaIds.includes(id));
    if (!sector) continue;
    out.push({
      unitId: id,
      unitName: file?.units.find((u) => u.id === id)?.name ?? id,
      sector: sector.name,
    });
  }
  return out;
}

/** Ask whether to delete these units; nothing changes until `confirmDeleteAntennas`. */
export function askDeleteAntennas(ids: readonly string[]): void {
  const { file } = antennaStore.getState();
  if (deleteBlockedReason() || !file || ids.length === 0) return;
  const units = ids.flatMap((id) => file.units.filter((u) => u.id === id));
  if (units.length === 0) return;
  const held = sectorsHolding(units.map((u) => u.id));
  antennaDeleteStore.setState({
    ask: {
      ids: units.map((u) => u.id),
      names: units.map((u) => u.name),
      sectors: held,
      planUnsaved: held.length > 0 && rfStore.getState().dirty,
    },
    busy: false,
  });
}

export function cancelDeleteAntennas(): void {
  if (antennaDeleteStore.getState().busy) return;
  antennaDeleteStore.setState({ ask: null });
}

/** The person's yes: delete, then take the units out of the plan. A failure keeps the question open. */
export async function confirmDeleteAntennas(): Promise<void> {
  const { ask, busy } = antennaDeleteStore.getState();
  if (!ask || busy) return;
  antennaDeleteStore.setState({ busy: true });
  const r = await deleteUnits(ask.ids);
  if (!r.ok) {
    antennaDeleteStore.setState({ busy: false, ask: null });
    // main's text is a whole sentence; an empty one is a guard (no file, project switched)
    if (r.error) antennaStore.setState({ message: r.error });
    return;
  }
  try {
    await removeAntennasFromPlan(ask.ids);
  } finally {
    antennaDeleteStore.setState({ ask: null, busy: false });
  }
}
