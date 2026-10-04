import type { Layer } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Whether the bottom timeline shows when nobody chose: only when the project has video clips.
 * The timeline exists to play and scrub footage; timed photos and capture dates alone put marks
 * on it but give it nothing to play (a facade survey of photos, a two-survey stockpile), so there
 * the 3D view takes the room and a thin bar brings the timeline back.
 */
export function timelineByDefault(layers: readonly Pick<Layer, 'kind'>[]): boolean {
  return layers.some((l) => l.kind === 'video');
}

/** The user's choice for the project, else the default for its data. */
export function timelineShown(
  saved: boolean | undefined,
  layers: readonly Pick<Layer, 'kind'>[],
): boolean {
  return saved ?? timelineByDefault(layers);
}

const KEY = 'stratlas.timeline';

function parse(raw: string | null | undefined): Record<string, boolean> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [id, shown] of Object.entries(v)) if (typeof shown === 'boolean') out[id] = shown;
    return out;
  } catch {
    return {};
  }
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface TimelinePrefState {
  /** Shown or hidden, per project id, where the user chose. */
  byProject: Record<string, boolean>;
  set(projectId: string, shown: boolean): void;
}

/** Timeline shown or hidden, remembered per project on this machine. */
export function createTimelinePref(
  storage: KeyValue | null = browserStorage(),
): StoreApi<TimelinePrefState> {
  let initial: Record<string, boolean> = {};
  try {
    initial = parse(storage?.getItem(KEY));
  } catch {
    // blocked storage: start with the defaults
  }
  const store = createStore<TimelinePrefState>()((set, get) => ({
    byProject: initial,
    set: (projectId, shown) => {
      set({ byProject: { ...get().byProject, [projectId]: shown } });
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

export const timelinePref = createTimelinePref();

/** The open project's timeline: shown or not, from the choice or the data. */
export function useTimelineShown(
  project: { id: string; manifest: { layers: readonly Pick<Layer, 'kind'>[] } } | null,
): boolean {
  const saved = useStore(timelinePref, (s) => (project ? s.byProject[project.id] : undefined));
  return project ? timelineShown(saved, project.manifest.layers) : false;
}

/** Show or hide the open project's timeline (T, the bar, the palette). */
export function toggleTimeline(
  project: { id: string; manifest: { layers: readonly Pick<Layer, 'kind'>[] } } | null,
  store: StoreApi<TimelinePrefState> = timelinePref,
): void {
  if (!project) return;
  const now = timelineShown(store.getState().byProject[project.id], project.manifest.layers);
  store.getState().set(project.id, !now);
}
