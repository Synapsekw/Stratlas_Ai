/**
 * The delete question for antennas: which units, which RF sectors hold them, and the flow after a
 * yes (delete from the inventory, then take them out of the coverage plan). The dialog
 * (`AntennaDeleteDialog`) shows `useAntennaDelete`. A delete can be undone from its notice
 * (`AntennaUndoNotice`, `undoDeleteAntennas`): the units go back into the current file and into
 * their sectors.
 */
import type { RfAntennaSettings } from '@aio/schema';
import { createStore, useStore } from 'zustand';
import { removeAntennasFromPlan, restoreAntennasToSectors, rfStore } from '../rf/rfStore';
import {
  antennaStore,
  deleteBlockedReason,
  deleteUnits,
  restoreUnits,
  type RemovedUnit,
} from './antennaStore';

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

/**
 * The person's yes: delete, then take the units out of the plan, and offer the delete for undo.
 * A refusal closes the question and says why in the Antennas group.
 */
export async function confirmDeleteAntennas(): Promise<void> {
  const { ask, busy } = antennaDeleteStore.getState();
  if (!ask || busy) return;
  antennaDeleteStore.setState({ busy: true });
  const projectId = antennaStore.getState().projectId;
  const r = await deleteUnits(ask.ids);
  if (!r.ok) {
    antennaDeleteStore.setState({ busy: false, ask: null });
    // main's text is a whole sentence; an empty one is a guard (no file, project switched)
    if (r.error) antennaStore.setState({ message: r.error });
    return;
  }
  // the units' places in the plan, as they are before the removal takes them out
  const places = sectorPlaces(r.removed.map((x) => x.unit.id));
  try {
    await removeAntennasFromPlan(ask.ids);
  } finally {
    antennaDeleteStore.setState({ ask: null, busy: false });
  }
  if (projectId && r.removed.length > 0) {
    const { undo } = antennaUndoStore.getState();
    antennaUndoStore.setState({
      undo: [...undo, { projectId, seq: ++undoSeq, removed: r.removed, places }].slice(
        -UNDO_DELETES,
      ),
    });
  }
}

// ---------------------------------------------------------------- undo

/**
 * What the delete takes out of the coverage plan for one unit: its sector (with its name, should
 * the delete have emptied it) and its RF settings, each when it had one.
 */
export interface SectorPlace {
  unitId: string;
  sectorId?: string;
  sectorName?: string;
  settings?: RfAntennaSettings;
}

/** One delete that can still be undone; `seq` makes each one new. */
export interface AntennaUndo {
  projectId: string;
  seq: number;
  removed: RemovedUnit[];
  /** The sectors that held them (none when the plan held none, or is not this project's). */
  places: SectorPlace[];
}

/** How many deletes back Undo reaches, as for measurements. */
const UNDO_DELETES = 10;
let undoSeq = 0;

export const antennaUndoStore = createStore<{ undo: readonly AntennaUndo[] }>()(() => ({
  undo: [],
}));

export function useAntennaUndo<T>(selector: (s: { undo: readonly AntennaUndo[] }) => T): T {
  return useStore(antennaUndoStore, selector);
}

/**
 * The sector places and RF settings of `ids` in the open project's plan, before the delete takes
 * them out (exactly what `removeAntennasFromPlan` removes); a unit with neither is left out.
 */
function sectorPlaces(ids: readonly string[]): SectorPlace[] {
  const rf = rfStore.getState();
  if (!rf.hasFile || rf.projectId !== antennaStore.getState().projectId) return [];
  return ids.flatMap((unitId) => {
    const sector = rf.sectors.sectors.find((s) => s.antennaIds.includes(unitId));
    const settings = rf.sectors.antennas.find((a) => a.antennaId === unitId);
    if (!sector && !settings) return [];
    return [
      {
        unitId,
        ...(sector ? { sectorId: sector.id, sectorName: sector.name } : {}),
        ...(settings ? { settings } : {}),
      },
    ];
  });
}

/**
 * Undo the last delete: the units go back into the current file at their old places (one ordinary
 * save, `restoreUnits`; main then puts their crops and deletion records back), then each goes back
 * into its sector with its RF settings (`restoreAntennasToSectors`: the saved plan is written,
 * unsaved edits stay unsaved; a sector the delete emptied comes back). The delete before it is offered next. Refused
 * while an antenna job runs; a delete of another project is dropped.
 */
export async function undoDeleteAntennas(): Promise<void> {
  const { undo } = antennaUndoStore.getState();
  const last = undo.at(-1);
  if (!last) return;
  const { projectId } = antennaStore.getState();
  if (last.projectId !== projectId) {
    antennaUndoStore.setState({ undo: undo.filter((u) => u.projectId === projectId) });
    return;
  }
  if (deleteBlockedReason()) return;
  antennaUndoStore.setState({ undo: undo.slice(0, -1) });
  const written = await restoreUnits(last.removed);
  if (!written || last.places.length === 0) return;
  if (rfStore.getState().projectId !== projectId) return;
  await restoreAntennasToSectors(last.places);
}

/** Let go of every delete's undo (the notice closes). */
export function dismissUndoDeleteAntennas(): void {
  antennaUndoStore.setState({ undo: [] });
}
