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
}

export function createOdmStore(b: Bridge, on: AioBridge['on'] | undefined): StoreApi<OdmUi> {
  let following = false;
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
        if (!following && on) {
          following = true;
          on('odm:progress', (p) => {
            if (get().installing) set({ progress: p });
          });
        }
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
    };
  });
}
