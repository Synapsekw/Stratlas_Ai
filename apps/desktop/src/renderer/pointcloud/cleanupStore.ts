/**
 * The open project's point cloud cleanup (spec sections 2 and 5): one undo history per layer, the
 * Clean up panel's state, and the notice with Undo. Every step is written through
 * `pointcloud:writeCleanup` (one write at a time per layer); the present recipe is pushed to the
 * viewer's live store (`@aio/pointcloud` `pointcloudCleanup`). A failed write takes the step back
 * and the notice says why.
 *
 * Noise working copies: main sweeps unreferenced copies only on a null write or when the request
 * carries `keep`. Ordinary steps omit `keep`; every null write and every step that changes which
 * noise copy the recipe names (a noise run, Reset, undo, redo) sends the copies the whole history
 * still names. Loading a recipe also writes it once, unchanged, to sweep earlier sessions' leftovers.
 */
import { pointcloudCleanup, pointcloudSettings, type CleanupRecipes } from '@aio/pointcloud';
import type { Layer, PointcloudCleanup } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from '../bridge';
import { bridge } from '../shell';
import { initial, push, redo, referencedCopies, undo, type History } from './cleanupHistory';

export const isCleanable = (l: Layer): boolean => l.kind === 'pointcloud' && l.format === 'copc';

export type NoticeKind = 'hidden' | 'deleted' | 'classSet' | 'noise' | 'reset';

export interface CleanupNotice {
  text: string;
  undo: boolean;
  error: boolean;
  layerId: string | null;
  at: number;
}

export interface PendingSelection {
  layerId: string;
  shape: 'box' | 'lasso';
  polygon: [number, number][];
  /** World to clip (cleanupFrame.ts `worldViewProj`). */
  viewProj: number[];
  count: number;
}

export interface CleanupState {
  projectId: string | null;
  readOnly: boolean;
  layers: Record<string, History>;
  active: string | null;
  panelOpen: boolean;
  section: 'noise' | 'save' | null;
  selectShape: 'box' | 'lasso';
  pending: PendingSelection | null;
  busy: 'noise' | 'save' | null;
  notice: CleanupNotice | null;
}

interface Deps {
  call: Bridge['call'];
  recipes: StoreApi<CleanupRecipes>;
  now?: () => number;
  /** The global hidden classes (`pointcloudSettings`), the start of a cloud's first recipe. */
  globalHidden?: () => readonly number[];
}

function noticeText(n: { kind: NoticeKind; name?: string; count?: number }): string {
  switch (n.kind) {
    case 'hidden':
      return t('cleanup.notice.hidden');
    case 'deleted':
      return t('cleanup.notice.deleted');
    case 'classSet':
      return t('cleanup.notice.classSet', { name: n.name ?? '' });
    case 'noise':
      return t('cleanup.notice.noise', { count: n.count ?? 0 });
    case 'reset':
      return t('cleanup.notice.reset');
  }
}

export function createCleanup(deps: Deps) {
  const now = deps.now ?? (() => Date.now());
  const store = createStore<CleanupState>()(() => ({
    projectId: null,
    readOnly: false,
    layers: {},
    active: null,
    panelOpen: false,
    section: null,
    selectShape: 'box',
    pending: null,
    busy: null,
    notice: null,
  }));
  /** One write at a time per layer, in the order the steps were made. */
  const queues = new Map<string, Promise<unknown>>();
  /** The project id whose recipes were loaded (once per id, spec ruling F11). */
  let loadedFor: string | null = null;

  const notify = (n: Omit<CleanupNotice, 'at'>) => {
    store.setState({ notice: { ...n, at: now() } });
  };
  const fail = (layerId: string | null, error: string) => {
    notify({ text: t('cleanup.notice.error', { error }), undo: false, error: true, layerId });
  };
  const show = (layerId: string, h: History) => {
    store.setState((s) => ({ layers: { ...s.layers, [layerId]: h } }));
    deps.recipes.getState().set(layerId, h.present);
  };
  /** Queue one write for the layer; resolves to an error text or null. */
  const send = (
    layerId: string,
    recipe: PointcloudCleanup | null,
    keep: string[] | undefined,
  ): Promise<string | null> => {
    const projectId = store.getState().projectId;
    if (!projectId) return Promise.resolve('No project is open.');
    const run = async (): Promise<string | null> => {
      try {
        const r = await deps.call('pointcloud:writeCleanup', {
          projectId,
          layerId,
          recipe,
          ...(keep ? { keep } : {}),
        });
        if (!r.ok) return r.error;
        return r.value.ok ? null : r.value.error;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const next = (queues.get(layerId) ?? Promise.resolve()).then(run, run);
    queues.set(layerId, next);
    return next;
  };
  /**
   * Main sweeps unnamed noise copies on a null write and whenever `keep` is present, so every null
   * write and every step that changes the noise copy names all copies the history still holds
   * (undo and redo must never point at a trashed file). Ordinary steps send no keep.
   */
  const write = (layerId: string, back: History, h: History): Promise<string | null> => {
    const noiseChanged = (back.present?.noise?.path ?? null) !== (h.present?.noise?.path ?? null);
    const sweep = noiseChanged || h.present === null;
    return send(layerId, h.present, sweep ? referencedCopies(h) : undefined);
  };
  /** Show `next`, write it; on a refusal show `back` again. */
  const step = async (layerId: string, back: History, next: History): Promise<boolean> => {
    show(layerId, next);
    const error = await write(layerId, back, next);
    if (error === null) return true;
    if (store.getState().layers[layerId] === next) show(layerId, back);
    fail(layerId, error);
    return false;
  };
  const historyOf = (layerId: string) => store.getState().layers[layerId] ?? initial(null);
  /**
   * A cloud with no recipe shows the global hidden classes; its first recipe starts from them, so
   * starting a cleanup never shows classes the person had hidden. Later steps are the recipe's own.
   */
  const seeded = (layerId: string, next: PointcloudCleanup | null): PointcloudCleanup | null => {
    if (!next || historyOf(layerId).present !== null) return next;
    const global = deps.globalHidden?.() ?? [];
    if (global.length === 0) return next;
    const hidden = [...new Set([...global, ...next.hiddenClasses])].sort((a, b) => a - b);
    return { ...next, hiddenClasses: hidden };
  };
  const writable = () => {
    const s = store.getState();
    return s.projectId !== null && !s.readOnly;
  };

  return {
    store,
    notify,
    recipeOf: (layerId: string) => store.getState().layers[layerId]?.present ?? null,

    async load(projectId: string, layers: readonly Layer[]): Promise<void> {
      if (loadedFor === projectId) return; // once per project id
      loadedFor = projectId;
      queues.clear();
      store.setState({
        projectId,
        readOnly: false,
        layers: {},
        active: null,
        pending: null,
        busy: null,
        notice: null,
      });
      deps.recipes.getState().clear();
      const r = await deps.call('pointcloud:readCleanup', { projectId });
      if (store.getState().projectId !== projectId) return; // another project opened meanwhile
      if (!r.ok || !r.value.ok) {
        loadedFor = null; // let a later load try again
        fail(null, r.ok ? (r.value.ok ? '' : r.value.error) : r.error);
        return;
      }
      const { recipes, readOnly } = r.value;
      const ids = new Set(layers.filter(isCleanable).map((l) => l.id));
      const known = new Set(layers.map((l) => l.id));
      const next: Record<string, History> = {};
      for (const recipe of recipes) {
        if (ids.has(recipe.layerId)) {
          next[recipe.layerId] = initial(recipe);
          deps.recipes.getState().set(recipe.layerId, recipe);
        } else if (!known.has(recipe.layerId) && !readOnly) {
          // its layer was deleted: remove the recipe (kept as .bak); a null write also sweeps
          // the layer's noise copies, so no keep is sent
          void send(recipe.layerId, null, undefined).then((error) => {
            if (error)
              console.warn(`Cleanup of removed layer "${recipe.layerId}" not removed`, error);
          });
        }
      }
      store.setState({ layers: next, readOnly });
      // The history is empty: write each loaded recipe unchanged with keep naming only its own
      // copy, so copies left by an earlier session go to the trash. Not an undo step.
      if (!readOnly) {
        for (const [id, h] of Object.entries(next)) {
          const own = h.present?.noise?.path;
          void send(id, h.present, own ? [own] : []).then((error) => {
            if (error) console.warn(`Cleanup sweep of layer "${id}" failed`, error);
          });
        }
      }
    },

    async commit(
      layerId: string,
      next: PointcloudCleanup | null,
      notice?: { kind: NoticeKind; name?: string; count?: number },
    ): Promise<boolean> {
      if (!writable()) return false;
      const h = historyOf(layerId);
      const n = push(h, seeded(layerId, next));
      if (n === h) return true;
      const ok = await step(layerId, h, n);
      if (ok && notice) notify({ text: noticeText(notice), undo: true, error: false, layerId });
      return ok;
    },

    preview(layerId: string, recipe: PointcloudCleanup | null): void {
      deps.recipes.getState().set(layerId, seeded(layerId, recipe));
    },

    async undo(layerId?: string): Promise<boolean> {
      const id = layerId ?? store.getState().active;
      if (!id || !writable()) return false;
      const h = historyOf(id);
      const u = undo(h);
      return u ? step(id, h, u) : false;
    },

    async redo(layerId?: string): Promise<boolean> {
      const id = layerId ?? store.getState().active;
      if (!id || !writable()) return false;
      const h = historyOf(id);
      const r = redo(h);
      return r ? step(id, h, r) : false;
    },

    async reset(layerId: string): Promise<boolean> {
      if (!writable()) return false;
      const h = historyOf(layerId);
      const n = push(h, null);
      if (n === h) return true;
      const ok = await step(layerId, h, n);
      if (ok) notify({ text: noticeText({ kind: 'reset' }), undo: true, error: false, layerId });
      return ok;
    },

    /** The project closed: the next `load` reads again, even for the same project id. */
    close: () => {
      loadedFor = null;
      queues.clear();
      deps.recipes.getState().clear();
      store.setState({
        projectId: null,
        readOnly: false,
        layers: {},
        active: null,
        pending: null,
        busy: null,
        notice: null,
      });
    },

    setActive: (id: string | null) => {
      store.setState({ active: id, pending: null });
    },
    openPanel: (layerId?: string, section?: 'noise' | 'save') => {
      store.setState((s) => ({
        panelOpen: true,
        active: layerId ?? s.active,
        section: section ?? null,
      }));
    },
    closePanel: () => {
      store.setState({ panelOpen: false, pending: null, section: null });
    },
    setShape: (selectShape: 'box' | 'lasso') => {
      store.setState({ selectShape });
    },
    setPending: (pending: PendingSelection | null) => {
      store.setState({ pending });
    },
    setBusy: (busy: 'noise' | 'save' | null) => {
      store.setState({ busy });
    },
    dismiss: () => {
      store.setState({ notice: null });
    },
  };
}

export type Cleanup = ReturnType<typeof createCleanup>;

export const cleanup: Cleanup = createCleanup({
  call: (channel, req) => bridge.call(channel, req),
  recipes: pointcloudCleanup,
  globalHidden: () => pointcloudSettings.getState().hiddenClasses,
});

/**
 * The recipes belong to the open project, whatever the stage shows: load them when a project opens
 * (the export dialog and the right-click menu need them in Map mode too), and on a project change
 * close the panel and forget the recipes and the history first. Only the project id counts: a
 * manifest reload (a saved copy arriving) must not reset the history. Called once at start-up from
 * bootstrap; returns the unsubscribe.
 */
export function followProjectForCleanup(
  c: Cleanup = cleanup,
  ws: typeof workspace = workspace,
): () => void {
  const loadOpen = () => {
    const p = ws.getState().project;
    if (p) void c.load(p.id, p.manifest.layers);
  };
  loadOpen();
  return ws.subscribe((s, prev) => {
    if ((s.project?.id ?? null) === (prev.project?.id ?? null)) return;
    c.close();
    c.closePanel();
    loadOpen();
  });
}

export function useCleanup<T>(selector: (s: CleanupState) => T): T {
  return useStore(cleanup.store, selector);
}
