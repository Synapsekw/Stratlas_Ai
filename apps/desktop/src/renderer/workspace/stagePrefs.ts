import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { parseDrawingDisplay, type DrawingDisplay } from '../drawings/display';
import { parseCutawayPref, type CutawayPref } from './cutaway';
import { parseSplitPref, type SplitPref } from './splitModel';
import { parseVideoRect, type VideoRect } from './videoWindow';

/** Stage layout choices remembered per project on this machine. */
export interface StagePref {
  /** Where the floating video window sits and how wide it is (absent: the default place). */
  video?: VideoRect;
  /** Where the docked video sits: beside the views or under them (absent: beside). */
  videoDock?: 'side' | 'bottom';
  /** Off, Cut or Transparent, and the see-through opacity (absent: off). */
  cutaway?: CutawayPref;
  /** What each side of the split stage shows (absent: 3D left, map right). */
  split?: SplitPref;
  /** Drone telemetry (trace and HUD) while a clip plays or scrubs (absent: on). */
  telemetry?: boolean;
  /** Opacity and on top of each drawing, by plan layer (absent: as the views draw them). */
  drawings?: DrawingDisplay;
}

const KEY = 'stratlas.stagePrefs';

function parsePref(v: unknown): StagePref {
  if (!v || typeof v !== 'object') return {};
  const raw = v as Record<string, unknown>;
  const out: StagePref = {};
  const video = parseVideoRect(raw.video);
  if (video) out.video = video;
  if (raw.videoDock === 'side' || raw.videoDock === 'bottom') out.videoDock = raw.videoDock;
  const cutaway = parseCutawayPref(raw.cutaway);
  if (cutaway) out.cutaway = cutaway;
  const split = parseSplitPref(raw.split);
  if (split) out.split = split;
  if (typeof raw.telemetry === 'boolean') out.telemetry = raw.telemetry;
  const drawings = parseDrawingDisplay(raw.drawings);
  if (drawings) out.drawings = drawings;
  return out;
}

function parse(raw: string | null | undefined): Record<string, StagePref> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, StagePref> = {};
    for (const [id, p] of Object.entries(v)) out[id] = parsePref(p);
    return out;
  } catch {
    return {};
  }
}

export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface StagePrefState {
  byProject: Record<string, StagePref>;
  /** Merge into the project's choices; a key set to `undefined` goes back to its default. */
  update(projectId: string, patch: { [K in keyof StagePref]?: StagePref[K] | undefined }): void;
}

export function createStagePrefStore(
  storage: Storage | null = browserStorage(),
): StoreApi<StagePrefState> {
  let initial: Record<string, StagePref> = {};
  try {
    initial = parse(storage?.getItem(KEY));
  } catch {
    // blocked storage: start with the defaults
  }
  const store = createStore<StagePrefState>()((set, get) => ({
    byProject: initial,
    update: (projectId, patch) => {
      // re-read through the parser: unset keys drop out, nothing malformed is kept
      const next = parsePref({ ...get().byProject[projectId], ...patch });
      set({ byProject: { ...get().byProject, [projectId]: next } });
    },
  }));
  store.subscribe((s) => {
    try {
      storage?.setItem(KEY, JSON.stringify(s.byProject));
    } catch {
      // private window or blocked storage: the choice is just not remembered
    }
  });
  return store;
}

export const stagePrefs = createStagePrefStore();

export function useStagePrefs<T>(selector: (s: StagePrefState) => T): T {
  return useStore(stagePrefs, selector);
}

/** The one-time notice that T opens the tools now (the timeline moved to View): on this computer. */
const T_NOTICE_KEY = 'stratlas.tNoticeSeen';
/** Without storage, once in this run. */
let tNoticeShown = false;

/** True the first time it is asked on this computer, false after. */
export function takeTNotice(storage: Storage | null = browserStorage()): boolean {
  try {
    if (storage) {
      if (storage.getItem(T_NOTICE_KEY)) return false;
      storage.setItem(T_NOTICE_KEY, '1');
      return true;
    }
  } catch {
    // blocked storage: once in this run
  }
  if (tNoticeShown) return false;
  tNoticeShown = true;
  return true;
}
