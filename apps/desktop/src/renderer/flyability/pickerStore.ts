import type { InspectorScan } from '@aio/schema';
import { t, toast } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { builder } from '../builder/state';
import { bridge } from '../shell';
import {
  initialChoice,
  selectionOf,
  toggleFlight,
  toggleInspection,
  type Choice,
} from './pickerModel';

export { isInspectorUiOn } from './flag';

interface PickerState {
  /** The export folder being chosen from; null while the picker is closed. */
  path: string | null;
  scan: InspectorScan | null;
  choice: Choice | null;
}

const CLOSED: PickerState = { path: null, scan: null, choice: null };

export const picker = createStore<PickerState>(() => CLOSED);
export const usePicker = <T>(select: (s: PickerState) => T): T => useStore(picker, select);

/** The latest request wins: a scan that comes back after a newer open or a close is dropped. */
let ticket = 0;

/** Read the export and open the picker on it. A failed read says so and opens nothing. */
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
  const scan = r.value.scan;
  if (scan.inspections.length === 0) {
    toast(t('fly.picker.none'), { tone: 'warn', testId: 'inspector-none' });
    return;
  }
  picker.setState({ path, scan, choice: initialChoice(scan) });
}

export function closeInspectorPicker(): void {
  ticket++;
  picker.setState(CLOSED);
}

export function toggleInspectionTick(id: string): void {
  const { scan, choice } = picker.getState();
  if (scan && choice) picker.setState({ choice: toggleInspection(choice, scan, id) });
}

export function toggleFlightTick(inspectionId: string, flightId: string): void {
  const { scan, choice } = picker.getState();
  if (scan && choice)
    picker.setState({ choice: toggleFlight(choice, scan, inspectionId, flightId) });
}

/** Send the choice to the import and close the picker; the import runs and reports as any other. */
export async function confirmInspectorPicker(): Promise<void> {
  const { path, scan, choice } = picker.getState();
  if (path === null || !scan || !choice) return;
  const inspector = selectionOf(choice, scan);
  if (inspector === null) return;
  closeInspectorPicker();
  try {
    await builder.getState().importFiles([path], undefined, { inspector });
  } catch (e) {
    toast(t('fly.picker.importFailed'), {
      tone: 'error',
      detail: e instanceof Error ? e.message : String(e),
      testId: 'inspector-import-failed',
    });
  }
}
