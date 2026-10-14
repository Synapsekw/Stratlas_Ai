/**
 * The store behind Settings, Processing tools, Processing engine card (see odm.ts for the app's
 * instance): the ODM status, a running install and the question about another ODM. No window and
 * no singleton here, so it runs in a unit test with a fake bridge.
 */
import type { AioBridge, OdmInstallProgress, OdmInstallResult, OdmStatus } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from './bridge';

export interface OdmUi {
  /** null until main answered. */
  status: OdmStatus | null;
  /** The running install; null when none runs. */
  progress: OdmInstallProgress | null;
  installing: boolean;
  error: string | null;
  /** Another ODM is on this computer and the install would replace it: ask first. */
  askReplace: boolean;
  load(): Promise<void>;
  install(replaceOther?: boolean): Promise<void>;
  cancel(): Promise<void>;
  remove(): Promise<void>;
  setGpu(on: boolean): Promise<void>;
  /** Close the replace question. */
  keep(): void;
  /** Stop following install progress (the next `load` follows it again). */
  dispose(): void;
}

export function createOdmStore(b: Bridge, on: AioBridge['on'] | undefined): StoreApi<OdmUi> {
  /** The one subscription to `odm:progress`, kept for the life of the app (see `dispose`). */
  let unfollow: (() => void) | null = null;
  return createStore<OdmUi>()((set, get) => {
    /** Take an answer that carries the new status; a refusal shows its reason (a cancel is silent). */
    const take = (v: OdmInstallResult) => {
      if (v.ok) set({ status: v.status });
      else if (v.code !== 'cancelled') set({ error: v.error });
    };
    return {
      status: null,
      progress: null,
      installing: false,
      error: null,
      askReplace: false,

      load: async () => {
        // an install can end with the card closed, so the store follows progress from the first
        // load on, once; a second load never adds a second listener
        unfollow ??=
          on?.('odm:progress', (p) => {
            if (get().installing) set({ progress: p });
          }) ?? null;
        const r = await b.call('odm:status', {});
        if (!r.ok) {
          set({ error: r.error });
          return;
        }
        set({ status: r.value, installing: get().installing || r.value.installing });
      },

      install: async (replaceOther) => {
        if (get().installing) return;
        set({ installing: true, progress: null, error: null, askReplace: false });
        const r = await b.call('odm:install', replaceOther === true ? { replaceOther } : {});
        set({ installing: false, progress: null });
        if (!r.ok) {
          set({ error: r.error });
          return;
        }
        if (!r.value.ok && r.value.code === 'other-install') {
          set({ askReplace: true });
          return;
        }
        take(r.value);
        // a refusal (no Windows x64, a development folder, offline only, no disk space, an install
        // already running) or a failed or cancelled install: show what main says now, so the card
        // offers what is possible (a running install shows up with its Cancel)
        if (!r.value.ok) await get().load();
      },

      cancel: async () => {
        const r = await b.call('odm:cancel', {});
        if (!r.ok) set({ error: r.error });
      },

      remove: async () => {
        set({ error: null });
        const r = await b.call('odm:remove', {});
        if (!r.ok) set({ error: r.error });
        else take(r.value);
      },

      setGpu: async (gpuOn) => {
        set({ error: null });
        const r = await b.call('odm:setGpu', { gpu: gpuOn ? 'auto' : 'off' });
        if (!r.ok) set({ error: r.error });
        else take(r.value);
      },

      keep: () => {
        set({ askReplace: false });
      },

      dispose: () => {
        unfollow?.();
        unfollow = null;
      },
    };
  });
}
