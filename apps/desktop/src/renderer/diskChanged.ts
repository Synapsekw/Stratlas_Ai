/**
 * Compare-before-write on shared folders (M9 integration): main refuses a record save when the
 * file changed on disk since this app read it (someone else saved it from another computer). The
 * refusal names the file and says "was changed by someone else since you opened it."; the IPC
 * answers have no code for it, so the phrase is the contract (`CHANGED_ON_DISK_PHRASE` in main's
 * fsutil.ts). This store holds the one refusal shown, and `reloadFromDisk` reads the open
 * project's records again (the person's unsaved edit is dropped; they make it again).
 */
import { changeStore } from '@aio/change';
import { issueSaver } from '@aio/annotate';
import { volumetric } from '@aio/volumetric';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { detections, loadDetections } from './detections/store';
import { modeller } from './modeller';
import { bridge } from './shell';

/** The stable part of main's refusal (fsutil.ts `CHANGED_ON_DISK_PHRASE`). */
export const CHANGED_ON_DISK_PHRASE = 'was changed by someone else since you opened it.';

export function isChangedOnDisk(error: string | null | undefined): error is string {
  return typeof error === 'string' && error.includes(CHANGED_ON_DISK_PHRASE);
}

export interface DiskChanged {
  /** The refusal shown, or null. */
  message: string | null;
  reloading: boolean;
  /** Bumped by every reload, for views that keep records in component state (report text). */
  reloads: number;
  /** Why the last reload failed. */
  error: string | null;
  report(message: string): void;
  dismiss(): void;
}

export const diskChanged = createStore<DiskChanged>()((set) => ({
  message: null,
  reloading: false,
  reloads: 0,
  error: null,
  report: (message) => {
    set({ message, error: null });
  },
  dismiss: () => {
    set({ message: null, error: null });
  },
}));

export function useDiskChanged<T>(selector: (s: DiskChanged) => T): T {
  return useStore(diskChanged, selector);
}

/** Report `error` when it is a changed-on-disk refusal; true when it was. */
export function reportIfChangedOnDisk(error: string | null | undefined): boolean {
  if (!isChangedOnDisk(error)) return false;
  diskChanged.getState().report(error);
  return true;
}

/**
 * Read the open project's records again from disk: issues and manifest (through `project:open`,
 * which main also takes as the version seen), then change sets, detections, models and stockpile
 * edits where they are loaded, and the report text (through `reloads`). Queued issue saves are
 * dropped first: they were made over the old version.
 */
export async function reloadFromDisk(): Promise<void> {
  const project = workspace.getState().project;
  if (!project) return;
  diskChanged.setState({ reloading: true, error: null });
  issueSaver.cancel();
  const r = await bridge.call('project:open', { path: project.root });
  const ws = workspace.getState();
  if (ws.project?.id !== project.id) {
    diskChanged.setState({ reloading: false });
    return;
  }
  if (!r.ok || !r.value.ok) {
    diskChanged.setState({
      reloading: false,
      error: !r.ok ? r.error : r.value.ok ? '' : r.value.error,
    });
    return;
  }
  ws.replaceManifest(r.value.manifest);
  workspace.setState({ issues: r.value.issues });
  const others: Promise<unknown>[] = [];
  if (changeStore.getState().projectId === project.id) {
    others.push(changeStore.getState().load(project.id));
  }
  if (detections.getState().projectId === project.id) {
    others.push(loadDetections(project.id, true));
  }
  if (volumetric.getState().projectId === project.id) others.push(volumetric.getState().load());
  const m = modeller.getState();
  others.push(m.refresh());
  if (m.model) others.push(m.openModel(m.model.id));
  await Promise.allSettled(others);
  diskChanged.setState((s) => ({ reloading: false, message: null, reloads: s.reloads + 1 }));
}

/**
 * Watch the record savers for a changed-on-disk refusal: issues (the saver), change reviews,
 * detections, models and stockpile edits. Answers the stop function.
 */
export function watchDiskChanged(): () => void {
  const stops = [
    issueSaver.subscribe((s) => {
      if (s.state === 'error') reportIfChangedOnDisk(s.error);
    }),
    changeStore.subscribe((s, prev) => {
      if (s.error !== prev.error) reportIfChangedOnDisk(s.error);
    }),
    detections.subscribe((s, prev) => {
      if (s.save.error !== prev.save.error) reportIfChangedOnDisk(s.save.error);
    }),
    modeller.subscribe((s, prev) => {
      if (s.error !== prev.error) reportIfChangedOnDisk(s.error);
    }),
    volumetric.subscribe((s, prev) => {
      if (s.message !== prev.message) reportIfChangedOnDisk(s.message);
    }),
    // another project: the refusal was about the one before
    workspace.subscribe((s, prev) => {
      if (s.project?.id !== prev.project?.id) diskChanged.getState().dismiss();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
