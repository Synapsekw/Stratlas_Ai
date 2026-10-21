/**
 * The Process photos UI state (G4): which panel is open (the wizard or a run), and what the wizard
 * asked for after alignment (products start by themselves when the alignment finishes, unless the
 * person marks ground control first). Session state only: a run's own files say what was done.
 */
import type { JobRecord, PhotoPreset, PhotoProduct, PipelineName } from '@aio/schema';
import { createStore, useStore } from 'zustand';
import type { WizardInitial } from './startOver';
import { productsFor } from './estimate';

export type RunTab = 'progress' | 'gcp' | 'report' | 'poses';

export type PhotoView =
  { kind: 'wizard'; initial?: WizardInitial } | { kind: 'run'; run: string; tab: RunTab };

/** Products to start when a run's alignment finishes (the wizard's choice). */
export interface PendingProducts {
  root: string;
  preset: PhotoPreset;
  products: PhotoProduct[];
  capture?: string;
  /** A survey date to add for this day just before the maps are built (never with `capture`). */
  captureDate?: string;
}

/** A survey date that could not be saved for a run's maps: its day, and the run's project folder. */
export interface DateWarning {
  date: string;
  root: string;
}

export interface PhotoUi {
  view: PhotoView | null;
  pending: Record<string, PendingProducts>;
  /** Runs the person paused or stopped in this session (their jobs are cancelled, resumable). */
  stopped: Record<string, 'paused' | 'cancelled'>;
  /** The wizard's survey date pick per run, for a run that builds its maps later (ground control first). */
  dates: Record<string, { capture?: string; captureDate?: string }>;
  /** Why the maps of a run did not start, until a start works (the run panel says it). */
  startErrors: Record<string, string>;
  /**
   * Runs whose maps were started without the survey date wanted, because it could not be saved:
   * the day (`YYYY-MM-DD`) that failed and the folder of the project the run belongs to, so
   * filing them under it later acts on that project only.
   */
  dateWarnings: Record<string, DateWarning>;
  /**
   * Run ids handed out in this session (dialog and agent): main lists a run only once photo.align
   * has read its photos, so a new id avoids these too and two starts never share a run folder.
   */
  held: string[];
  /** A line under a run in its panel (Start over's old run that stayed). */
  notes: Record<string, string>;
  /** When the person pressed Keep waiting on a job's stuck notice (memory only, never saved). */
  keptWaiting: Record<string, number>;
  /** Bumped after a write, so open panels read the run again. */
  version: number;
  openWizard: (initial?: WizardInitial) => void;
  openRun: (run: string, tab?: RunTab) => void;
  setTab: (tab: RunTab) => void;
  close: () => void;
  setPending: (run: string, p: PendingProducts | null) => void;
  setStopped: (run: string, s: 'paused' | 'cancelled' | null) => void;
  setDate: (run: string, d: { capture?: string; captureDate?: string } | null) => void;
  setStartError: (run: string, error: string | null) => void;
  setDateWarning: (run: string, warning: DateWarning | null) => void;
  /** Hold a run id (true) or free it again after a refused start (false). */
  holdRun: (run: string, hold: boolean) => void;
  setNote: (run: string, note: string | null) => void;
  keepWaiting: (jobId: string, at: number) => void;
  bump: () => void;
}

export const photoUi = createStore<PhotoUi>()((set) => ({
  view: null,
  pending: {},
  stopped: {},
  dates: {},
  startErrors: {},
  dateWarnings: {},
  held: [],
  notes: {},
  keptWaiting: {},
  version: 0,
  holdRun: (run, hold) => {
    set((s) => ({ held: [...s.held.filter((r) => r !== run), ...(hold ? [run] : [])] }));
  },
  openWizard: (initial) => {
    set({ view: initial ? { kind: 'wizard', initial } : { kind: 'wizard' } });
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
      if (p) pending[run] = { ...p, products: productsFor(p.preset, p.products) };
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
  setDate: (run, d) => {
    set((s) => {
      const dates = Object.fromEntries(Object.entries(s.dates).filter(([k]) => k !== run));
      if (d && (d.capture || d.captureDate)) dates[run] = d;
      return { dates };
    });
  },
  setStartError: (run, error) => {
    set((s) => {
      const startErrors = Object.fromEntries(
        Object.entries(s.startErrors).filter(([k]) => k !== run),
      );
      if (error) startErrors[run] = error;
      return { startErrors };
    });
  },
  setDateWarning: (run, warning) => {
    set((s) => {
      const dateWarnings = Object.fromEntries(
        Object.entries(s.dateWarnings).filter(([k]) => k !== run),
      );
      if (warning) dateWarnings[run] = warning;
      return { dateWarnings };
    });
  },
  keepWaiting: (jobId, at) => {
    set((s) => ({ keptWaiting: { ...s.keptWaiting, [jobId]: at } }));
  },
  setNote: (run, note) => {
    set((s) => {
      const notes = Object.fromEntries(Object.entries(s.notes).filter(([k]) => k !== run));
      if (note) notes[run] = note;
      return { notes };
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
  sfm: 'Align the photos (ODM)',
  georef: 'Place the model',
  adjust: 'Adjust with ground control (ODM)',
  report: 'Report',
  dense: 'Dense point cloud',
  cloud: 'Point cloud',
  dsm: 'Elevation models',
  ortho: 'Orthophoto',
  mesh: '3D mesh',
  texture: 'Texture the mesh',
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
