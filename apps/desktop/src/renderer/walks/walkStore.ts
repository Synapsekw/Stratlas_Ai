import type { WalkFile } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';

/*
 * The 360 videos of the open project (`walks:list`). A walk is not a manifest layer, so the
 * workspace store does not know it: this store asks main when the project changes and after an
 * import, and remembers which walk the pane shows.
 */

export interface WalkState {
  /** The project the list belongs to (null: none open). */
  projectId: string | null;
  walks: WalkFile[];
  /** The walk the 360 video pane shows (null: the first). */
  selected: string | null;
  /** Ask main for the project's walks; a stale answer (the project changed meanwhile) is dropped. */
  load(projectId: string | null): Promise<void>;
  select(id: string): void;
}

/** What main answers to `walks:list`, as the bridge wraps it. */
export type WalkListCall = (
  projectId: string,
) => Promise<{ ok: true; value: { walks: WalkFile[] } } | { ok: false; error: string }>;

export function createWalkStore(call: WalkListCall): StoreApi<WalkState> {
  return createStore<WalkState>()((set, get) => ({
    projectId: null,
    walks: [],
    selected: null,
    load: async (projectId) => {
      if (projectId !== get().projectId) set({ projectId, walks: [], selected: null });
      if (projectId === null) return;
      const r = await call(projectId);
      if (get().projectId !== projectId) return;
      const walks = r.ok ? r.value.walks : [];
      const selected = get().selected;
      set({ walks, selected: walks.some((w) => w.id === selected) ? selected : null });
    },
    select: (id) => {
      if (get().walks.some((w) => w.id === id)) set({ selected: id });
    },
  }));
}
