/**
 * What the Processing chip and drawer remember for the session: whether the drawer is open, the
 * job whose details show, when each project's drawer was last looked at (the chip's "needs
 * attention" counts from there) and the one start dialog. Nothing here is saved.
 */
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { folderKey, type JobDraft } from '../jobs';

export interface ProcessingUi {
  open: boolean;
  /** The job whose details the drawer shows, or null for the list. */
  picked: string | null;
  /** When this session started (ISO). */
  start: string;
  /** Per project folder key: when its drawer was last opened or closed (ISO). */
  seen: Record<string, string>;
  /** One pipeline to start for the open project (`PipelineDialog`), or null. */
  dialog: JobDraft | null;
  /** Open the drawer, on a job's details when `jobId` is given. */
  openDrawer: (jobId?: string) => void;
  closeDrawer: () => void;
  pick: (id: string | null) => void;
  openDialog: (req: JobDraft) => void;
  closeDialog: () => void;
}

export function seenAtOf(s: Pick<ProcessingUi, 'seen'>, root: string | null): string | null {
  return root === null ? null : (s.seen[folderKey(root)] ?? null);
}

export function createProcessingStore(deps: {
  now: () => Date;
  root: () => string | null;
}): StoreApi<ProcessingUi> {
  const looked = (seen: Record<string, string>): Record<string, string> => {
    const root = deps.root();
    return root === null ? seen : { ...seen, [folderKey(root)]: deps.now().toISOString() };
  };
  return createStore<ProcessingUi>()((set) => ({
    open: false,
    picked: null,
    start: deps.now().toISOString(),
    seen: {},
    dialog: null,
    openDrawer: (jobId) => {
      set((s) => ({ open: true, picked: jobId ?? null, seen: looked(s.seen) }));
    },
    closeDrawer: () => {
      set((s) => ({ open: false, picked: null, seen: looked(s.seen) }));
    },
    pick: (id) => {
      set({ picked: id });
    },
    openDialog: (req) => {
      set({ dialog: req });
    },
    closeDialog: () => {
      set({ dialog: null });
    },
  }));
}

/** The app's one. */
export const processing = createProcessingStore({
  now: () => new Date(),
  root: () => workspace.getState().project?.root ?? null,
});

export function useProcessing<T>(selector: (s: ProcessingUi) => T): T {
  return useStore(processing, selector);
}
