import type { InspectorMission, InspectorScan } from '@aio/schema';
import { t, toast } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { builder } from '../builder/state';
import { bridge } from '../shell';
import {
  flatScan,
  initialChoice,
  missionOfScan,
  missionRequest,
  toggleChamber,
  toggleFlight,
  toggleInspection,
  type Choice,
} from './pickerModel';

export { isInspectorUiOn } from './flag';

interface PickerState {
  /** The folder being chosen from (an export or a mission folder); null while closed. */
  path: string | null;
  /** Every export found in it; null when the picker was opened on one bare scan (tests). */
  mission?: InspectorMission | null;
  /** All the chambers' inspections as one scan (the per-inspection ticks). */
  scan: InspectorScan | null;
  choice: Choice | null;
}

const CLOSED: PickerState = { path: null, mission: null, scan: null, choice: null };

/** The mission the picker shows: the one scanned, or the bare scan as a mission of one. */
export function pickerMission(s: PickerState): InspectorMission | null {
  if (s.mission) return s.mission;
  return s.path !== null && s.scan ? missionOfScan(s.path, s.scan) : null;
}

export const picker = createStore<PickerState>(() => CLOSED);
export const usePicker = <T>(select: (s: PickerState) => T): T => useStore(picker, select);

/** The latest request wins: a scan that comes back after a newer open or a close is dropped. */
let ticket = 0;

/**
 * Read the folder for exports and open the picker on what it found (an empty picker says no
 * export was found, with a hint). A failed read says so and opens nothing; exports without any
 * inspection say so in a notice.
 */
export async function openInspectorPicker(path: string): Promise<void> {
  const mine = ++ticket;
  const r = await bridge.call('builder:inspectorScan', {
    projectId: workspace.getState().project?.id ?? null,
    path,
  });
  if (mine !== ticket) return;
  if (!r.ok || !r.value.ok) {
    const detail = !r.ok ? r.error : r.value.ok ? '' : r.value.error;
    toast(t('fly.picker.scanFailed'), {
      tone: 'error',
      ...(detail ? { detail } : {}),
      testId: 'inspector-scan-failed',
    });
    return;
  }
  const mission = r.value.mission;
  const scan = flatScan(mission);
  if (mission.exports.length > 0 && scan.inspections.length === 0) {
    toast(t('fly.picker.none'), { tone: 'warn', testId: 'inspector-none' });
    return;
  }
  picker.setState({ path, mission, scan, choice: initialChoice(scan) });
}

export function closeInspectorPicker(): void {
  ticket++;
  picker.setState(CLOSED);
}

export function toggleInspectionTick(id: string): void {
  const { scan, choice } = picker.getState();
  if (scan && choice) picker.setState({ choice: toggleInspection(choice, scan, id) });
}

/** A chamber's tick: all its inspections on, or off. */
export function toggleChamberTick(path: string): void {
  const s = picker.getState();
  const e = pickerMission(s)?.exports.find((x) => x.path === path);
  if (e && s.choice) picker.setState({ choice: toggleChamber(s.choice, e.scan) });
}

export function toggleFlightTick(inspectionId: string, flightId: string): void {
  const { scan, choice } = picker.getState();
  if (scan && choice)
    picker.setState({ choice: toggleFlight(choice, scan, inspectionId, flightId) });
}

/** Send the choice to the import and close the picker; the import runs and reports as any other. */
export async function confirmInspectorPicker(): Promise<void> {
  const state = picker.getState();
  const mission = pickerMission(state);
  if (!mission || !state.choice) return;
  const request = missionRequest(state.choice, mission);
  if (request === null) return;
  closeInspectorPicker();
  try {
    // the ticked chambers' own folders: each becomes its own job, one after the other
    await builder.getState().importFiles(request.paths, undefined, {
      inspector: request.inspector,
    });
  } catch (e) {
    toast(t('fly.picker.importFailed'), {
      tone: 'error',
      detail: e instanceof Error ? e.message : String(e),
      testId: 'inspector-import-failed',
    });
  }
}
