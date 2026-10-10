import {
  captureSelection,
  clockInClip,
  followLayer,
  initialFocus,
  openChange,
  snapshotPref,
  stepCapture,
  swapChange,
  useWorkspace,
  workspace as appWorkspace,
  type CaptureIndex,
  type DatePref,
  type Workspace,
} from '@aio/workspace';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { getMedia } from '../media';
import { useCaptureIndex } from './compare';
import { browserStorage } from './stagePrefs';

export const TIMELINE_KEY = 'stratlas.timeline';

/**
 * A stockpile project's volumes (the volumetric store), which own its survey layers: the date bar
 * asks them to show a survey and mirrors the survey they show.
 */
export interface VolumeDates {
  projectId: string;
  /** The survey key of a capture, when the volumes have it. */
  epochOf(capture: string): string | undefined;
  /** The survey key the volumes show now. */
  epoch(): string;
  /** Show a survey; the volumes switch its layers, or refuse (mid boundary edit). */
  setEpoch(epoch: string): void;
}

/** Who shows and hides the survey layers of the open project. */
export type DateOwner = 'timeline' | 'volumetric';

export interface TimelineState {
  projectId: string | null;
  index: CaptureIndex | null;
  focus: string | null;
  byProject: Record<string, DatePref>;
  /** 'volumetric' while the open project's volumes are loaded with their surveys. */
  owner: DateOwner;
  /** Called whenever the open project or its capture index changes. */
  attach(projectId: string | null, index: CaptureIndex | null): void;
  focusSurvey(capture: string): void;
  step(dir: -1 | 1): void;
  /** The open project's volumes took over its survey layers (null: they let go). */
  setVolumes(volumes: VolumeDates | null): void;
  /** The volumes show `capture`: focus it without touching visibility. */
  mirrorFocus(capture: string): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

/** A saved pref with every malformed field dropped, or null when it is not a pref at all. */
function coercePref(v: unknown): DatePref | null {
  if (!isRecord(v)) return null;
  const pref: DatePref = {};
  if (typeof v.focus === 'string') pref.focus = v.focus;
  if (isRecord(v.remembered)) {
    const remembered: Record<string, string[]> = {};
    for (const [capture, ids] of Object.entries(v.remembered)) {
      const list = strings(ids);
      if (list) remembered[capture] = list;
    }
    pref.remembered = remembered;
  }
  const extras = strings(v.extras);
  if (extras) pref.extras = extras;
  return pref;
}

function load(storage: Storage | null): Record<string, DatePref> {
  try {
    const raw = storage?.getItem(TIMELINE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const out: Record<string, DatePref> = {};
    if (!isRecord(parsed)) return out;
    for (const [id, v] of Object.entries(parsed)) {
      const pref = coercePref(v);
      if (pref) out[id] = pref;
    }
    return out;
  } catch {
    return {};
  }
}

/** Snapshots the open project's pref from the current visibility and writes it through to storage. */
function persist(
  store: StoreApi<TimelineState>,
  ws: StoreApi<Workspace>,
  storage: Storage | null,
  hidden: Readonly<Record<string, true>>,
): void {
  const { projectId, index, focus, byProject, owner } = store.getState();
  if (!projectId || !index || index.captures.length === 0) return;
  // a stale index (another project open, not yet attached) never writes the wrong project
  if (ws.getState().project?.id !== projectId) return;
  // the volumes own the layers: only the date is saved, never hides they made
  const pref: DatePref =
    owner === 'volumetric'
      ? focus
        ? { focus }
        : {}
      : snapshotPref(index, hidden, focus, byProject[projectId]?.remembered ?? {});
  const next = { ...byProject, [projectId]: pref };
  store.setState({ byProject: next });
  try {
    storage?.setItem(TIMELINE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the timeline still works for this session.
  }
}

/** Clip length in ms from the video metadata, when known. */
export type ClipDuration = (layerId: string) => number | undefined;

const mediaDuration: ClipDuration = (id) => getMedia().durations[id];

export function createTimelineStore(
  ws: StoreApi<Workspace> = appWorkspace,
  storage: Storage | null = browserStorage(),
  durationOf: ClipDuration = mediaDuration,
): StoreApi<TimelineState> {
  /** Play `next` instead of the active clip, the clock moved into it the way a date jump keeps it. */
  const moveClip = (next: string | null) => {
    const w = ws.getState();
    const prev = w.activeClip;
    if (next === prev) return;
    w.setActiveClip(next);
    const layers = w.project?.manifest.layers ?? [];
    const video = (id: string | null) => {
      const l = id ? layers.find((x) => x.id === id) : undefined;
      return l?.kind === 'video' ? l : undefined;
    };
    const to = video(next);
    if (to) w.setTime(clockInClip(video(prev), to, w.nowMs, durationOf(to.id)));
  };

  /** The active clip of the date left behind, played on `next` instead. */
  const followClip = (index: CaptureIndex, prev: string | null, next: string) => {
    const w = ws.getState();
    const clip = w.activeClip;
    if (clip && prev && index.of[clip] === prev) {
      const layers = w.project?.manifest.layers ?? [];
      moveClip(followLayer(index, layers, clip, next) ?? null);
    }
  };

  let volumes: VolumeDates | null = null;
  const ownerOf = (projectId: string | null): DateOwner =>
    volumes?.projectId === projectId ? 'volumetric' : 'timeline';

  // `openProject` bumps the workspace's `openSeq` (visibility is reset from the manifest);
  // `replaceManifest` and issue edits do not. Comparing it tells a fresh open from a manifest
  // edit while the project stays open.
  let attachedSeq = -1;
  const store = createStore<TimelineState>()((set, get) => ({
    projectId: null,
    index: null,
    focus: null,
    byProject: load(storage),
    owner: 'timeline',

    attach: (projectId, index) => {
      const s = get();
      const fresh = ws.getState().openSeq !== attachedSeq;
      if (!fresh && s.projectId === projectId && s.index === index) return;
      attachedSeq = ws.getState().openSeq;
      const owner = ownerOf(projectId);
      if (!projectId || !index || index.captures.length === 0) {
        set({ projectId, index, focus: null, owner });
        return;
      }
      if (!fresh && s.projectId === projectId && s.index) {
        // Same project, manifest changed: keep focus if it still exists, never reset visibility.
        const focus =
          s.focus && index.captures.some((c) => c.id === s.focus)
            ? s.focus
            : initialFocus(index, undefined);
        set({ index, focus, owner });
        return;
      }
      const pref = s.byProject[projectId] ?? {};
      const vol = owner === 'volumetric' ? volumes : null;
      if (vol) {
        // the volumes already show their survey: focus it and leave the layers to them
        const shown = index.captures.find((c) => vol.epochOf(c.id) === vol.epoch());
        set({ projectId, index, owner, focus: shown?.id ?? initialFocus(index, pref.focus) });
      } else {
        // Claim the project before touching visibility so the subscription below
        // writes the new project's pref, never the previous project's.
        const opened = initialFocus(index, pref.focus);
        set({ projectId, index, focus: opened, owner });
        const change = openChange(index, ws.getState().hidden, opened, pref);
        ws.getState().applyVisibility(change.show, change.hide);
      }
      const focus = get().focus;
      // the project opened on its first clip: play the focused date's footage instead
      const clip = ws.getState().activeClip;
      const from = clip ? index.of[clip] : undefined;
      if (clip && focus && from && from !== focus) {
        const next = followLayer(index, ws.getState().project?.manifest.layers ?? [], clip, focus);
        if (next) moveClip(next);
      }
    },

    focusSurvey: (capture) => {
      const { index, focus: prev, projectId, byProject } = get();
      if (!index || !projectId || capture === prev) return;
      if (!index.captures.some((c) => c.id === capture)) return;
      const w = ws.getState();
      if (w.project?.id !== projectId) return;
      const vol = get().owner === 'volumetric' ? volumes : null;
      if (vol) {
        // the volumes switch the layers (or refuse mid edit); the survey they show comes back
        // through mirrorFocus. A date the volumes do not have only moves the focus.
        const epoch = vol.epochOf(capture);
        if (epoch) vol.setEpoch(epoch);
        if (!epoch || vol.epoch() === epoch) get().mirrorFocus(capture);
        return;
      }
      const { change, remembered } = swapChange(
        index,
        w.hidden,
        prev,
        capture,
        byProject[projectId]?.remembered ?? {},
      );
      w.applyVisibility(change.show, change.hide);

      followClip(index, prev, capture);
      const sel = w.selection;
      if (sel?.layer && prev && index.of[sel.layer] === prev) {
        w.select(sel.kind === 'asset' ? captureSelection(index, capture, sel) : null);
      }

      set({
        focus: capture,
        byProject: { ...byProject, [projectId]: { ...byProject[projectId], remembered } },
      });
      persist(store, ws, storage, ws.getState().hidden);
    },

    step: (dir) => {
      const { index, focus } = get();
      if (!index) return;
      const next = stepCapture(index, focus, dir);
      if (next) get().focusSurvey(next);
    },

    setVolumes: (next) => {
      volumes = next;
      const owner = ownerOf(get().projectId);
      if (owner === get().owner) return;
      set({ owner });
      // from now on only the date is saved for this project
      if (owner === 'volumetric') persist(store, ws, storage, ws.getState().hidden);
    },

    mirrorFocus: (capture) => {
      const { index, focus: prev, projectId, owner } = get();
      if (owner !== 'volumetric' || !index || !projectId || capture === prev) return;
      if (!index.captures.some((c) => c.id === capture)) return;
      if (ws.getState().project?.id !== projectId) return;
      followClip(index, prev, capture);
      set({ focus: capture });
      persist(store, ws, storage, ws.getState().hidden);
    },
  }));

  // Visibility changes from anywhere (sidebar, palette, tools) update the saved pref.
  ws.subscribe((s, p) => {
    // Opening or closing a project resets `hidden` before the timeline re-attaches, so
    // that update is never persisted (attach re-applies the saved pref), and only the open
    // project's pref is ever written.
    if (
      s.hidden !== p.hidden &&
      s.openSeq === p.openSeq &&
      s.project?.id === store.getState().projectId
    ) {
      persist(store, ws, storage, s.hidden);
    }
  });

  return store;
}

export const timeline = createTimelineStore();

export function useTimeline<T>(selector: (s: TimelineState) => T): T {
  return useStore(timeline, selector);
}

/** Keeps the timeline attached to the open project. Mount once, in the app. */
export function useTimelineSync(): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const openSeq = useWorkspace((s) => s.openSeq);
  const index = useCaptureIndex();
  useEffect(() => {
    // the views read the dates from the workspace to leave out the annotations of a hidden date;
    // set before the timeline hides the other dates' layers, so both land in one redraw
    appWorkspace.getState().setDates(projectId ? index : null);
    timeline.getState().attach(projectId, index);
  }, [projectId, index, openSeq]);
}
