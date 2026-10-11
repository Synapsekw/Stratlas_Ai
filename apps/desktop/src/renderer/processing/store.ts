/**
 * What the Processing chip and drawer remember: whether the drawer is open, the job whose details
 * show, when each project's drawer was last looked at (the chip's "needs attention" counts from
 * there) and the one start dialog. Only the looks outlast the session: they are kept on this
 * computer (one `localStorage` key, folder key to ISO time) so an interrupted job that was seen
 * does not light the chip again at every start.
 */
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { folderKey, type JobDraft } from '../jobs';
import { photoUi } from '../photogrammetry/store';
import type { NoticeStorage } from '../processingToolsStore';

/** Where the looks are kept: a JSON map of project folder key to the ISO time of the look. */
export const LOOKED_KEY = 'quadrion.processing.looked';

export interface ProcessingUi {
  open: boolean;
  /** The job whose details the drawer shows, or null for the list. */
  picked: string | null;
  /** When this session started (ISO). */
  start: string;
  /** Per project folder key: when its drawer was last opened or closed (ISO), on this computer. */
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

/** The kept looks; storage that throws or holds something else than a map of times gives none. */
function readLooked(storage: NoticeStorage | null): Record<string, string> {
  try {
    const raw = storage?.getItem(LOOKED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const looks: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed))
      if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) looks[key] = value;
    return looks;
  } catch {
    return {};
  }
}

export function createProcessingStore(deps: {
  now: () => Date;
  root: () => string | null;
  /** True while a full-screen panel lies over the app: the drawer then does not open. */
  blocked?: () => boolean;
  /** Where the looks are kept; none keeps them for the session only. */
  storage?: NoticeStorage | null;
}): StoreApi<ProcessingUi> {
  const storage = deps.storage ?? null;
  const looked = (seen: Record<string, string>): Record<string, string> => {
    const root = deps.root();
    if (root === null) return seen;
    const next = { ...seen, [folderKey(root)]: deps.now().toISOString() };
    try {
      storage?.setItem(LOOKED_KEY, JSON.stringify(next));
    } catch {
      // blocked storage: the look counts for this session only
    }
    return next;
  };
  return createStore<ProcessingUi>()((set) => ({
    open: false,
    picked: null,
    start: deps.now().toISOString(),
    seen: readLooked(storage),
    dialog: null,
    openDrawer: (jobId) => {
      // it would lie under the panel; nothing was looked at
      if (deps.blocked?.()) return;
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

const localStore = (): NoticeStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The app's one. */
export const processing = createProcessingStore({
  now: () => new Date(),
  root: () => workspace.getState().project?.root ?? null,
  // the photo wizard and a run's panel cover the screen
  blocked: () => photoUi.getState().view !== null,
  storage: localStore(),
});

export function useProcessing<T>(selector: (s: ProcessingUi) => T): T {
  return useStore(processing, selector);
}
