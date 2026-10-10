/**
 * The store behind Settings, Processing tools and the start notice (see processingTools.ts for
 * the app's instance): what is installed, an archive found on this computer, a running install.
 * No window and no singleton here, so it runs in a unit test with a fake bridge.
 */
import type { AioBridge, PackArchive, PackInstallProgress, PipelinePackStatus } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from './bridge';

/** What the notice was dismissed for (a pack version, or that there is none), per profile. */
const DISMISSED_KEY = 'quadrion.processingTools.noticeDismissed';

/** The little of `localStorage` this needs (tests pass a map). */
export interface NoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ProcessingTools {
  /** null until main answered. */
  status: PipelinePackStatus | null;
  /** A newer pack archive found beside the app, in Downloads or in runtime. */
  offer: PackArchive | null;
  /** The running install; null when none runs. */
  progress: PackInstallProgress | null;
  installing: boolean;
  error: string | null;
  /** What just happened, for a sentence in Settings. */
  note: { kind: 'installed'; version: string } | { kind: 'removed'; name: string } | null;
  /** The archive whose version is installed already: asked before it replaces it. */
  replace: { path: string; version: string } | null;
  /** The notice key the person dismissed (`packNoticeKey`). */
  dismissed: string | null;
  /** Goes up when the installed packs change. */
  revision: number;
  /** Read the status and look for an archive. */
  load(): Promise<void>;
  /** Pick an archive with the file dialog, then install it. */
  choose(): Promise<void>;
  install(path: string, replace?: boolean): Promise<void>;
  cancel(): void;
  /** Move a pack that is not in use to the bin. */
  remove(name: string): Promise<void>;
  keepInstalled(): void;
  dismissNotice(): void;
}

/**
 * What the start notice is about, or null when there is nothing to say: the pack is fine, comes
 * from the environment, or this is an automated run. The key names the pack in use, so a notice
 * dismissed for one pack comes back only when another pack (or none) is the problem.
 */
export function packNoticeKey(status: PipelinePackStatus | null): string | null {
  if (!status?.notify) return null;
  if (status.state === 'ok' || status.state === 'dev') return null;
  return status.state === 'too-old' ? `too-old:${status.version ?? ''}` : status.state;
}

const readDismissed = (storage: NoticeStorage | null): string | null => {
  try {
    return storage?.getItem(DISMISSED_KEY) ?? null;
  } catch {
    return null;
  }
};

export function createProcessingToolsStore(
  b: Bridge,
  on: AioBridge['on'] | undefined,
  o: { storage?: NoticeStorage | null; onChanged?: () => void } = {},
): StoreApi<ProcessingTools> {
  const storage = o.storage ?? null;
  let following = false;
  /** This store started the running install and waits for its answer. */
  let own = false;
  return createStore<ProcessingTools>()((set, get) => {
    const changed = (status: PipelinePackStatus) => {
      set((s) => ({ status, revision: s.revision + 1 }));
      o.onChanged?.();
    };
    const find = async () => {
      const r = await b.call('pipelinePack:find', {});
      if (r.ok) set({ offer: r.value.offer });
    };
    return {
      status: null,
      offer: null,
      progress: null,
      installing: false,
      error: null,
      note: null,
      replace: null,
      dismissed: readDismissed(storage),
      revision: 0,

      load: async () => {
        if (!following && on) {
          following = true;
          on('pipelinePack:progress', (p) => {
            if (!get().installing) return;
            const over = p.phase === 'done' || p.phase === 'failed' || p.phase === 'cancelled';
            if (own || !over) {
              set({ progress: p });
              return;
            }
            // an install this window found running (it was reloaded meanwhile) has ended
            set({ installing: false, progress: null });
            o.onChanged?.();
            void get().load();
          });
        }
        const r = await b.call('pipelinePack:status', {});
        if (!r.ok) {
          set({ error: r.error });
          return;
        }
        set({ status: r.value, installing: get().installing || r.value.installing });
        await find();
      },

      choose: async () => {
        const r = await b.call('pipelinePack:choose', {});
        if (!r.ok) set({ error: r.error });
        else if (r.value.path) await get().install(r.value.path);
      },

      install: async (path, replace) => {
        if (get().installing) return;
        set({ installing: true, progress: null, error: null, note: null, replace: null });
        own = true;
        const r = await b.call('pipelinePack:install', {
          path,
          ...(replace === true ? { replace } : {}),
        });
        own = false;
        set({ installing: false, progress: null });
        if (!r.ok) {
          set({ error: r.error });
          return;
        }
        const v = r.value;
        if (v.ok) {
          set({ note: { kind: 'installed', version: v.version }, offer: null });
          changed(v.status);
          await find();
        } else if (v.code === 'exists' && v.version !== undefined) {
          set({ replace: { path, version: v.version } });
        } else if (v.code !== 'cancelled') {
          set({ error: v.error });
        }
      },

      cancel: () => {
        void b.call('pipelinePack:cancel', {});
      },

      remove: async (name) => {
        set({ error: null, note: null });
        const r = await b.call('pipelinePack:remove', { name });
        if (!r.ok) set({ error: r.error });
        else if (!r.value.ok) set({ error: r.value.error });
        else {
          set({ note: { kind: 'removed', name } });
          changed(r.value.status);
        }
      },

      keepInstalled: () => {
        set({ replace: null });
      },

      dismissNotice: () => {
        const key = packNoticeKey(get().status);
        if (key === null) return;
        set({ dismissed: key });
        try {
          storage?.setItem(DISMISSED_KEY, key);
        } catch {
          // blocked storage: dismissed for this run only
        }
      },
    };
  });
}
