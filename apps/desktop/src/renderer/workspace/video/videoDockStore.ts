/**
 * Where the project's video shows (UI revision D4): docked as a tile at the start of the bottom
 * strip (the default), popped out to a floating window over the stage, or closed. The mode is
 * kept per project, the floating window's place and size once for this user. No video, no tile:
 * the mode reads closed whatever was chosen, and the choice waits for the next clip.
 */
import { useWorkspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { parseVideoRect, type VideoRect } from '../videoWindow';

export type VideoDockMode = 'docked' | 'floating' | 'closed';

export const VIDEO_DOCK_KEY = 'quadrion.videoDock';

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const isMode = (v: unknown): v is VideoDockMode =>
  v === 'docked' || v === 'floating' || v === 'closed';

export interface VideoDockState {
  /** The user's choice per project id (absent: docked). */
  byProject: Readonly<Record<string, VideoDockMode>>;
  /** The floating window's place and size (null: first placed top-left of the stage). */
  rect: VideoRect | null;
  popOut: (projectId: string) => void;
  popIn: (projectId: string) => void;
  close: (projectId: string) => void;
  /** Back as the docked tile. */
  reopen: (projectId: string) => void;
  /** Back as it was before it closed (the W key's show): floating stays floating. */
  restore: (projectId: string) => void;
  setRect: (rect: VideoRect | null) => void;
  /** The mode each project had before it closed (this session only). */
  beforeClose: Readonly<Record<string, VideoDockMode>>;
  /** Where focus goes once a Pop out, Pop in or Close has rendered (taken once). */
  focus: VideoDockFocus | null;
  takeFocus: () => VideoDockFocus | null;
}

/** The control that takes focus after a move: the window's title bar, Pop out, or Show. */
export type VideoDockFocus = 'header' | 'popout' | 'show';

function load(storage: KeyValue | null): Pick<VideoDockState, 'byProject' | 'rect'> {
  try {
    const raw = storage?.getItem(VIDEO_DOCK_KEY);
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (!v || typeof v !== 'object') return { byProject: {}, rect: null };
    const byProject: Record<string, VideoDockMode> = {};
    const modes = v.byProject;
    if (modes && typeof modes === 'object')
      for (const [id, m] of Object.entries(modes)) if (isMode(m)) byProject[id] = m;
    return { byProject, rect: parseVideoRect(v.rect) };
  } catch {
    // malformed or blocked: docked, first place
    return { byProject: {}, rect: null };
  }
}

export function createVideoDockStore(
  storage: KeyValue | null = browserStorage(),
): StoreApi<VideoDockState> {
  const store = createStore<VideoDockState>()((set, get) => {
    const put = (projectId: string, mode: VideoDockMode) => {
      if (get().byProject[projectId] === mode) return;
      set({ byProject: { ...get().byProject, [projectId]: mode } });
    };
    return {
      ...load(storage),
      beforeClose: {},
      focus: null,
      popOut: (id) => {
        set({ focus: 'header' });
        put(id, 'floating');
      },
      popIn: (id) => {
        set({ focus: 'popout' });
        put(id, 'docked');
      },
      close: (id) => {
        const was = get().byProject[id] ?? 'docked';
        if (was !== 'closed')
          set({ beforeClose: { ...get().beforeClose, [id]: was }, focus: 'show' });
        put(id, 'closed');
      },
      reopen: (id) => {
        set({ focus: 'popout' });
        put(id, 'docked');
      },
      restore: (id) => {
        if (get().byProject[id] !== 'closed') return;
        put(id, get().beforeClose[id] ?? 'docked');
      },
      setRect: (rect) => {
        set({ rect });
      },
      takeFocus: () => {
        const f = get().focus;
        if (f) set({ focus: null });
        return f;
      },
    };
  });
  store.subscribe((s) => {
    try {
      storage?.setItem(VIDEO_DOCK_KEY, JSON.stringify({ byProject: s.byProject, rect: s.rect }));
    } catch {
      // private window or blocked storage: the choice lasts for this session
    }
  });
  return store;
}

export const videoDock = createVideoDockStore();

/** The mode shown: no video means closed; otherwise the choice, docked by default. */
export function dockMode(chosen: VideoDockMode | undefined, hasVideo: boolean): VideoDockMode {
  return hasVideo ? (chosen ?? 'docked') : 'closed';
}

/** The workspace as the dock reads it: the open project's layers and the active clip. */
export interface DockClipSource {
  project: { manifest: { layers: readonly { id: string; kind: string }[] } } | null;
  activeClip: string | null;
}

/**
 * The clip the tile and the window show: the active one, else the project's first video. The one
 * source for "is there a video to show" (the W key, the island's Video tile, the coverage legend).
 */
export function dockClipOf(s: DockClipSource): string | null {
  const layers = s.project?.manifest.layers ?? [];
  const v =
    layers.find((l) => l.id === s.activeClip && l.kind === 'video') ??
    layers.find((l) => l.kind === 'video');
  return v?.id ?? null;
}

export function useDockClip(): string | null {
  return useWorkspace(dockClipOf);
}

export interface VideoDockView {
  mode: VideoDockMode;
  /** The clip shown (null: the project has no video). */
  clip: string | null;
  rect: VideoRect | null;
  popOut: () => void;
  popIn: () => void;
  close: () => void;
  reopen: () => void;
}

/** The open project's video dock. */
export function useVideoDock(store: StoreApi<VideoDockState> = videoDock): VideoDockView {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const clip = useDockClip();
  const chosen = useStore(store, (s) => (projectId ? s.byProject[projectId] : undefined));
  const rect = useStore(store, (s) => s.rect);
  const run = (fn: (id: string) => void) => () => {
    if (projectId) fn(projectId);
  };
  const s = store.getState();
  return {
    mode: dockMode(chosen, clip !== null),
    clip,
    rect,
    popOut: run(s.popOut),
    popIn: run(s.popIn),
    close: run(s.close),
    reopen: run(s.reopen),
  };
}
