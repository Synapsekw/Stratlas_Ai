import {
  captureSelection,
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
import { useCaptureIndex } from './compare';
import { browserStorage } from './stagePrefs';

export const TIMELINE_KEY = 'stratlas.timeline';

export interface TimelineState {
  projectId: string | null;
  index: CaptureIndex | null;
  focus: string | null;
  byProject: Record<string, DatePref>;
  /** Called whenever the open project or its capture index changes. */
  attach(projectId: string | null, index: CaptureIndex | null): void;
  focusSurvey(capture: string): void;
  step(dir: -1 | 1): void;
}

function load(storage: Storage | null): Record<string, DatePref> {
  try {
    const raw = storage?.getItem(TIMELINE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, DatePref>) : {};
  } catch {
    return {};
  }
}

/** Snapshots the open project's pref from the current visibility and writes it through to storage. */
function persist(
  store: StoreApi<TimelineState>,
  storage: Storage | null,
  hidden: Readonly<Record<string, true>>,
): void {
  const { projectId, index, focus, byProject } = store.getState();
  if (!projectId || !index || index.captures.length === 0) return;
  const pref = snapshotPref(index, hidden, focus, byProject[projectId]?.remembered ?? {});
  const next = { ...byProject, [projectId]: pref };
  store.setState({ byProject: next });
  try {
    storage?.setItem(TIMELINE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the timeline still works for this session.
  }
}

export function createTimelineStore(
  ws: StoreApi<Workspace> = appWorkspace,
  storage: Storage | null = browserStorage(),
): StoreApi<TimelineState> {
  const store = createStore<TimelineState>()((set, get) => ({
    projectId: null,
    index: null,
    focus: null,
    byProject: load(storage),

    attach: (projectId, index) => {
      const s = get();
      if (s.projectId === projectId && s.index === index) return;
      if (!projectId || !index || index.captures.length === 0) {
        set({ projectId, index, focus: null });
        return;
      }
      if (s.projectId === projectId && s.index) {
        // Same project, manifest changed: keep focus if it still exists, never reset visibility.
        const focus =
          s.focus && index.captures.some((c) => c.id === s.focus)
            ? s.focus
            : initialFocus(index, undefined);
        set({ index, focus });
        return;
      }
      const pref = s.byProject[projectId] ?? {};
      const focus = initialFocus(index, pref.focus);
      // Claim the project before touching visibility so the subscription below
      // writes the new project's pref, never the previous project's.
      set({ projectId, index, focus });
      const change = openChange(index, ws.getState().hidden, focus, pref);
      ws.getState().applyVisibility(change.show, change.hide);
    },

    focusSurvey: (capture) => {
      const { index, focus: prev, projectId, byProject } = get();
      if (!index || !projectId || capture === prev) return;
      if (!index.captures.some((c) => c.id === capture)) return;
      const w = ws.getState();
      const { change, remembered } = swapChange(
        index,
        w.hidden,
        prev,
        capture,
        byProject[projectId]?.remembered ?? {},
      );
      w.applyVisibility(change.show, change.hide);

      const clip = w.activeClip;
      if (clip && prev && index.of[clip] === prev) {
        const layers = w.project?.manifest.layers ?? [];
        w.setActiveClip(followLayer(index, layers, clip, capture) ?? null);
      }
      const sel = w.selection;
      if (sel?.layer && prev && index.of[sel.layer] === prev) {
        w.select(sel.kind === 'asset' ? captureSelection(index, capture, sel) : null);
      }

      set({
        focus: capture,
        byProject: { ...byProject, [projectId]: { ...byProject[projectId], remembered } },
      });
      persist(store, storage, ws.getState().hidden);
    },

    step: (dir) => {
      const { index, focus } = get();
      if (!index) return;
      const next = stepCapture(index, focus, dir);
      if (next) get().focusSurvey(next);
    },
  }));

  // Visibility changes from anywhere (sidebar, palette, tools) update the saved pref.
  ws.subscribe((s, p) => {
    // Opening or closing a project resets `hidden` before the timeline re-attaches:
    // only persist while the store still describes the open project.
    if (s.hidden !== p.hidden && s.project?.id === store.getState().projectId) {
      persist(store, storage, s.hidden);
    }
  });

  return store;
}

export const timeline = createTimelineStore();

export function useTimeline<T>(selector: (s: TimelineState) => T): T {
  return useStore(timeline, selector);
}

/** Keeps the timeline attached to the open project. Mount once in the workspace screen. */
export function useTimelineSync(): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const index = useCaptureIndex();
  useEffect(() => {
    timeline.getState().attach(projectId, index);
  }, [projectId, index]);
}
