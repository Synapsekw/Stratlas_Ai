import type { Layer } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** A capture as the bottom slot reads it: only its date matters. */
export interface SlotCapture {
  date?: string | undefined;
}

/** The captures with a date that parses (an undated capture is never on the dates strip). */
export function datedCount(captures: readonly SlotCapture[] | undefined): number {
  let n = 0;
  for (const c of captures ?? []) if (c.date && Number.isFinite(Date.parse(c.date))) n += 1;
  return n;
}

/**
 * Whether the bottom timeline shows when nobody chose: when the project has video clips (the
 * footage timeline plays them) or two or more survey dates (the dates chart strip shows them,
 * volumetrics redesign section 5). Timed photos and a single date give it nothing to show (a
 * facade survey of photos), so there the 3D view takes the room.
 */
export function timelineByDefault(
  layers: readonly Pick<Layer, 'kind'>[],
  captures?: readonly SlotCapture[],
): boolean {
  return layers.some((l) => l.kind === 'video') || datedCount(captures) >= 2;
}

/**
 * Whether the project has a timeline to show at all: video clips for the footage timeline, or two
 * or more dated surveys for the dates strip. Without either the Timeline tile waits, greyed.
 */
export function timelineAvailable(
  layers: readonly Pick<Layer, 'kind'>[],
  captures?: readonly SlotCapture[],
): boolean {
  return timelineByDefault(layers, captures);
}

/** The user's choice for the project, else the default for its data; never with nothing to show. */
export function timelineShown(
  saved: boolean | undefined,
  layers: readonly Pick<Layer, 'kind'>[],
  captures?: readonly SlotCapture[],
): boolean {
  // with something to show, the default is shown
  return timelineAvailable(layers, captures) && (saved ?? true);
}

/** What the bottom slot under the stage shows. */
export type BottomSlot = 'dates' | 'footage' | 'none';
/** The choice of the "Dates | Footage" switch. */
export type BottomPref = 'dates' | 'footage';

/**
 * The bottom slot (spec section 5, "Coexistence with the video timeline"): hidden, nothing; no
 * video, the dates strip with two or more dates (else nothing: the tile waits for a second date);
 * video with fewer than two dates, the footage; video and two or more dates, the switch's choice,
 * by default Dates when the project has volume measurements and Footage otherwise.
 */
export function bottomSlot(x: {
  hasVideo: boolean;
  datedCaptures: number;
  hasVolumes: boolean;
  pref: BottomPref | null;
  shown: boolean;
}): BottomSlot {
  if (!x.shown) return 'none';
  const dates = x.datedCaptures >= 2;
  if (!x.hasVideo) return dates ? 'dates' : 'none';
  if (!dates) return 'footage';
  return x.pref ?? (x.hasVolumes ? 'dates' : 'footage');
}

/** Video and two or more dates: the bar offers the "Dates | Footage" switch. */
export function offersSwitch(x: { hasVideo: boolean; datedCaptures: number }): boolean {
  return x.hasVideo && x.datedCaptures >= 2;
}

/** Shown or hidden per project. The date prefs (`timeline.ts`) own `stratlas.timeline`. */
export const TIMELINE_SHOWN_KEY = 'stratlas.timeline.shown';
/** Until this fix the choice shared the date prefs' key; its boolean entries are read once. */
const LEGACY_KEY = 'stratlas.timeline';

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
    const saved = storage?.getItem(TIMELINE_SHOWN_KEY);
    initial = parse(saved ?? storage?.getItem(LEGACY_KEY));
    // move them now: the date prefs rewrite the old key with dates only on their next save
    if (saved == null && Object.keys(initial).length > 0) {
      storage?.setItem(TIMELINE_SHOWN_KEY, JSON.stringify(initial));
    }
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
      storage?.setItem(TIMELINE_SHOWN_KEY, JSON.stringify(s.byProject));
    } catch {
      // private window or blocked storage: the choice is just not remembered
    }
  });
  return store;
}

export const timelinePref = createTimelinePref();

/** A project as the timeline prefs read it. */
export interface PrefProject {
  id: string;
  manifest: { layers: readonly Pick<Layer, 'kind'>[]; captures?: readonly SlotCapture[] };
}

/** The open project's timeline: shown or not, from the choice or the data. */
export function useTimelineShown(project: PrefProject | null): boolean {
  const saved = useStore(timelinePref, (s) => (project ? s.byProject[project.id] : undefined));
  return project ? timelineShown(saved, project.manifest.layers, project.manifest.captures) : false;
}

/** Whether the open project has a timeline to show (the View tile greys out without one). */
export function hasTimeline(project: PrefProject | null): boolean {
  return project ? timelineAvailable(project.manifest.layers, project.manifest.captures) : false;
}

/** Show or hide the open project's timeline (the View tile, the palette); nothing to show, nothing. */
export function toggleTimeline(
  project: PrefProject | null,
  store: StoreApi<TimelinePrefState> = timelinePref,
): void {
  if (!project || !hasTimeline(project)) return;
  const now = timelineShown(
    store.getState().byProject[project.id],
    project.manifest.layers,
    project.manifest.captures,
  );
  store.getState().set(project.id, !now);
}

// ---------------------------------------------------------------- per-project choices

/** The "Dates | Footage" switch's choice, per project. */
export const BOTTOM_PREF_KEY = 'stratlas.timeline.bottom';
/** The dates strip folded to its bar, per project. */
export const DATES_COLLAPSED_KEY = 'stratlas.datesStrip.collapsed';

export interface ProjectChoiceState<T> {
  byProject: Readonly<Record<string, T>>;
  set(projectId: string, value: T): void;
}

/** A choice remembered per project under `key`; entries `valid` rejects are dropped on load. */
export function createProjectChoice<T>(
  key: string,
  valid: (v: unknown) => v is T,
  storage: KeyValue | null = browserStorage(),
): StoreApi<ProjectChoiceState<T>> {
  const initial: Record<string, T> = {};
  try {
    const raw = storage?.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (typeof v === 'object' && v !== null && !Array.isArray(v))
      for (const [id, x] of Object.entries(v)) if (valid(x)) initial[id] = x;
  } catch {
    // malformed or blocked: start with nothing chosen
  }
  const store = createStore<ProjectChoiceState<T>>()((set, get) => ({
    byProject: initial,
    set: (projectId, value) => {
      if (get().byProject[projectId] === value) return;
      set({ byProject: { ...get().byProject, [projectId]: value } });
    },
  }));
  store.subscribe((s) => {
    try {
      storage?.setItem(key, JSON.stringify(s.byProject));
    } catch {
      // private window or blocked storage: the choice lasts for this session
    }
  });
  return store;
}

export const isBottomPref = (v: unknown): v is BottomPref => v === 'dates' || v === 'footage';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** The switch's choice per project ("Dates | Footage"). */
export const bottomPref = createProjectChoice(BOTTOM_PREF_KEY, isBottomPref);
/** The dates strip collapsed to its 30 px bar, per project. */
export const datesCollapsed = createProjectChoice(DATES_COLLAPSED_KEY, isBoolean);
