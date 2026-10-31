import { spacesOf, type Space } from '@aio/schema';
import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { activeSpaceOf, mapAvailable } from './spaceModel';

const KEY = 'stratlas.activeSpace';

function parse(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [id, s] of Object.entries(v)) if (typeof s === 'string' && s) out[id] = s;
    return out;
  } catch {
    return {};
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface ActiveSpaceState {
  /** The space each project was last left in, on this machine. */
  byProject: Record<string, string>;
  set(projectId: string, spaceId: string): void;
}

/** The active space, remembered per project. Never writes the project's files. */
export function createActiveSpaceStore(
  storage: Storage | null = browserStorage(),
): StoreApi<ActiveSpaceState> {
  let initial: Record<string, string> = {};
  try {
    initial = parse(storage?.getItem(KEY));
  } catch {
    // blocked storage: start with none
  }
  const store = createStore<ActiveSpaceState>()((set, get) => ({
    byProject: initial,
    set: (projectId, spaceId) => {
      set({ byProject: { ...get().byProject, [projectId]: spaceId } });
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

export const activeSpace = createActiveSpaceStore();

export function setActiveSpace(projectId: string, spaceId: string): void {
  activeSpace.getState().set(projectId, spaceId);
}

/** The open project's active space, whether the map can show it, and all its spaces. */
export function useActiveSpace(): { spaceId: string; mapAvailable: boolean; spaces: Space[] } {
  const project = useWorkspace((s) => s.project);
  const pref = useStore(activeSpace, (s) => (project ? s.byProject[project.id] : undefined));
  const manifest = project?.manifest;
  return useMemo(() => {
    if (!manifest) return { spaceId: 'main', mapAvailable: true, spaces: [] };
    const spaceId = activeSpaceOf(manifest, pref);
    return { spaceId, mapAvailable: mapAvailable(manifest, spaceId), spaces: spacesOf(manifest) };
  }, [manifest, pref]);
}
