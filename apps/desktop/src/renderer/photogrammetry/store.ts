/**
 * The Process photos UI state (G4): which panel is open (the wizard or a run), and what the wizard
 * asked for after alignment (products start by themselves when the alignment finishes, unless the
 * person marks ground control first). Session state only: a run's own files say what was done.
 */
import type { JobRecord, PhotoPreset, PhotoProduct, PipelineName } from '@aio/schema';
import { createStore, useStore } from 'zustand';

export type RunTab = 'progress' | 'gcp' | 'report' | 'poses';

export type PhotoView = { kind: 'wizard' } | { kind: 'run'; run: string; tab: RunTab };

/** Products to start when a run's alignment finishes (the wizard's choice). */
export interface PendingProducts {
  root: string;
  preset: PhotoPreset;
  products: PhotoProduct[];
  capture?: string;
}

export interface PhotoUi {
  view: PhotoView | null;
  pending: Record<string, PendingProducts>;
  /** Runs the person paused or stopped in this session (their jobs are cancelled, resumable). */
  stopped: Record<string, 'paused' | 'cancelled'>;
  /** Bumped after a write, so open panels read the run again. */
  version: number;
  openWizard: () => void;
  openRun: (run: string, tab?: RunTab) => void;
  setTab: (tab: RunTab) => void;
  close: () => void;
  setPending: (run: string, p: PendingProducts | null) => void;
  setStopped: (run: string, s: 'paused' | 'cancelled' | null) => void;
  bump: () => void;
}

export const photoUi = createStore<PhotoUi>()((set) => ({
  view: null,
  pending: {},
  stopped: {},
  version: 0,
  openWizard: () => {
    set({ view: { kind: 'wizard' } });
  },
  openRun: (run, tab = 'progress') => {
    set({ view: { kind: 'run', run, tab } });
  },
  setTab: (tab) => {
    set((s) => (s.view?.kind === 'run' ? { view: { ...s.view, tab } } : s));
  },
  close: () => {
    set({ view: null });
  },
  setPending: (run, p) => {
    set((s) => {
      const pending = Object.fromEntries(Object.entries(s.pending).filter(([k]) => k !== run));
      if (p) pending[run] = p;
      return { pending };
    });
  },
  setStopped: (run, st) => {
    set((s) => {
      const stopped = Object.fromEntries(Object.entries(s.stopped).filter(([k]) => k !== run));
      if (st) stopped[run] = st;
      return { stopped };
    });
  },
  bump: () => {
    set((s) => ({ version: s.version + 1 }));
  },
}));

export function usePhotoUi<T>(selector: (s: PhotoUi) => T): T {
  return useStore(photoUi, selector);
}

export const PHOTO_PIPELINES: readonly PipelineName[] = [
  'photo.align',
  'photo.georef',
  'photo.products',
];

const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The run a photo job works on (`params.run`), or null for other jobs. */
export function runOfJob(job: Pick<JobRecord, 'pipeline' | 'params'>): string | null {
  if (!PHOTO_PIPELINES.includes(job.pipeline)) return null;
  const run = job.params.run;
  return typeof run === 'string' && run ? run : null;
}

/** The jobs of one run of the project at `root`, newest first. */
export function jobsOfRun(jobs: readonly JobRecord[], root: string, run: string): JobRecord[] {
  return jobs
    .filter((j) => runOfJob(j) === run && folderKey(j.project) === folderKey(root))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Stage titles in the words of the progress view (the pipeline's own titles win). */
export const STAGE_WORDS: Readonly<Record<string, string>> = {
  inspect: 'Read photos',
  features: 'Find features',
  match: 'Match photos',
  sfm: 'Place cameras',
  georef: 'Georeference',
  adjust: 'Adjust with control',
  report: 'Report',
  dense: 'Depth maps',
  fuse: 'Fuse points',
  cloud: 'Point cloud',
  dsm: 'Surface model',
  dtm: 'Terrain model',
  ortho: 'Orthomosaic',
  mesh: 'Mesh',
  texture: 'Texture',
  tiles: '3D Tiles',
  commit: 'Add layers',
};

/**
 * Jobs that finished between two lists: done now and not done before. A job missing from the
 * earlier list counts only when it was created after `since` (not an old job loaded at start).
 */
export function newlyDone(
  prev: readonly JobRecord[],
  next: readonly JobRecord[],
  since: string,
): JobRecord[] {
  return next.filter((j) => {
    if (j.status !== 'done') return false;
    const before = prev.find((p) => p.id === j.id);
    return before ? before.status !== 'done' : j.createdAt >= since;
  });
}
