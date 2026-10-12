import type { Layer, WalkFile, WalkLayer, WalkProcessSummary } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';

/*
 * The 360 walks of the open project. A walk is a manifest layer (kind `walk`), so the list follows
 * the manifest; main's `walks:list` only adds what the layer does not carry (the camera layout, a
 * low resolution copy) and tells which walk folders are still on disk. The store also remembers
 * which walk the 360 video pane shows.
 */

export interface WalkState {
  /** The project the list belongs to (null: none open). */
  projectId: string | null;
  /** The walk layers of the manifest, in manifest order. */
  walks: WalkLayer[];
  /** The `walk.json` records main listed, by their path in the project (`walks/<id>/walk.json`). */
  records: Readonly<Record<string, WalkFile>>;
  /** Record paths a `walks:list` answer covered: a walk among them that was not listed has lost its files. */
  checked: ReadonlySet<string>;
  /** What each processed walk's `process.json` says (`walk.process`), by walk folder id. */
  processed: Readonly<Record<string, WalkProcessSummary>>;
  /**
   * **Level horizon** per walk layer, as the person set it (absent: on). Kept over refreshes and
   * project changes: walk layer ids are unique to their clip.
   */
  level: Readonly<Record<string, boolean>>;
  /** Why starting `walk.process` on a walk was refused, by walk layer id, until it starts again. */
  startErrors: Readonly<Record<string, string>>;
  /** The walk layer the 360 video pane shows (null: the first). */
  selected: string | null;
  /**
   * Follow the manifest of the open project: its walk layers, the chosen one kept while it is
   * there. Main is asked for the records when a walk layer is new to the store.
   */
  sync(projectId: string | null, layers: readonly Layer[]): Promise<void>;
  /** Ask main for the records again; a stale answer (the project changed meanwhile) is dropped. */
  refresh(): Promise<void>;
  select(layerId: string): void;
  /**
   * Let go of a walk that is about to be removed: it leaves the list (so the 360 video pane
   * unmounts it and Chromium closes its playback file) and is no longer the chosen one. The next
   * `sync` brings it back if it is still in the manifest.
   */
  release(layerId: string): void;
  setLevel(layerId: string, on: boolean): void;
  setStartError(layerId: string, error: string | null): void;
}

/** What main answers to `walks:list`, as the bridge wraps it. */
export type WalkListCall = (projectId: string) => Promise<
  | {
      ok: true;
      value: { walks: WalkFile[]; processed?: Record<string, WalkProcessSummary> | undefined };
    }
  | { ok: false; error: string }
>;

const recordPath = (w: WalkFile) => `walks/${w.id}/walk.json`;

/** Where a walk layer's record is: its path in the project, or its content hash in a package store. */
export function walkRecordKey(layer: WalkLayer): string {
  return 'path' in layer.record
    ? layer.record.path.replace(/\\/g, '/')
    : `hash:${layer.record.hash}`;
}

/** The walk's folder id (`walks/<id>/walk.json`), or the layer id for a record stored elsewhere. */
export function walkFolderId(layer: WalkLayer): string {
  return /^walks\/([^/]+)\/walk\.json$/.exec(walkRecordKey(layer))?.[1] ?? layer.id;
}

/** Whether main was asked about this walk and did not list it: its folder is gone or unreadable. */
export function walkFilesMissing(
  s: Pick<WalkState, 'records' | 'checked'>,
  layer: WalkLayer,
): boolean {
  const key = walkRecordKey(layer);
  return s.checked.has(key) && !(key in s.records);
}

export function createWalkStore(call: WalkListCall): StoreApi<WalkState> {
  let asked = 0;
  let applied = 0;
  return createStore<WalkState>()((set, get) => ({
    projectId: null,
    walks: [],
    records: {},
    checked: new Set(),
    processed: {},
    level: {},
    startErrors: {},
    selected: null,
    sync: async (projectId, layers) => {
      if (projectId !== get().projectId)
        set({
          projectId,
          walks: [],
          records: {},
          checked: new Set(),
          processed: {},
          startErrors: {},
          selected: null,
        });
      if (projectId === null) return;
      const walks = layers.filter((l): l is WalkLayer => l.kind === 'walk');
      const selected = get().selected;
      set({ walks, selected: walks.some((w) => w.id === selected) ? selected : null });
      const { checked } = get();
      const unchecked = (w: WalkLayer) => {
        const key = walkRecordKey(w);
        return !key.startsWith('hash:') && !checked.has(key);
      };
      if (walks.some(unchecked)) await get().refresh();
    },
    refresh: async () => {
      const { projectId, walks } = get();
      if (projectId === null) return;
      const ask = ++asked;
      // a record held by hash (a package store) is not a walk folder main lists: never missing
      const paths = walks.map(walkRecordKey).filter((k) => !k.startsWith('hash:'));
      const r = await call(projectId);
      // an older answer never overwrites a newer one
      if (get().projectId !== projectId || ask < applied) return;
      applied = ask;
      if (!r.ok) {
        set({ records: {}, checked: new Set(), processed: {} });
        return;
      }
      set({
        records: Object.fromEntries(r.value.walks.map((w) => [recordPath(w), w])),
        checked: new Set(paths),
        processed: r.value.processed ?? {},
      });
    },
    select: (layerId) => {
      if (get().walks.some((w) => w.id === layerId)) set({ selected: layerId });
    },
    release: (layerId) => {
      const { walks, selected } = get();
      set({
        walks: walks.filter((w) => w.id !== layerId),
        selected: selected === layerId ? null : selected,
      });
    },
    setLevel: (layerId, on) => {
      set((s) => ({ level: { ...s.level, [layerId]: on } }));
    },
    setStartError: (layerId, error) => {
      set((s) => {
        const rest = Object.fromEntries(
          Object.entries(s.startErrors).filter(([k]) => k !== layerId),
        );
        return { startErrors: error === null ? rest : { ...rest, [layerId]: error } };
      });
    },
  }));
}
