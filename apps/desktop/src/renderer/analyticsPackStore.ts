/**
 * The store behind Settings, Analytics pack (see analyticsPack.ts for the app's instance): what is
 * installed, an archive found on this computer, a running install and whether the graphics card
 * can run detectors. No window and no singleton here, so it runs in a unit test with a fake
 * bridge. Modelled on processingToolsStore.ts.
 */
import type { AioBridge, HardwareCheck, IpcResponse, PackInstallProgress } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from './bridge';

export type AnalyticsPackStatus = IpcResponse<'analyticsPack:status'>;

export interface AnalyticsPack {
  /** null until main answered. */
  status: AnalyticsPackStatus | null;
  /** A newer pack archive found beside the app, in Downloads or in runtime. */
  offer: AnalyticsPackStatus['offer'];
  /** The running install; null when none runs. */
  progress: PackInstallProgress | null;
  installing: boolean;
  error: string | null;
  /** What just happened, for a sentence in Settings. */
  note: { kind: 'installed' | 'removed'; version: string } | null;
  /** The archive whose version is installed already: asked before it replaces it. */
  replace: { path: string; version: string } | null;
  /** The graphics card check; null until main answered. */
  hardware: HardwareCheck | null;
  checking: boolean;
  /** Read the status and check the graphics card. */
  load(): Promise<void>;
  /** Pick an archive with the file dialog, then install it. */
  choose(): Promise<void>;
  install(path: string, replace?: boolean): Promise<void>;
  cancel(): void;
  /** Move an installed version to the bin. */
  remove(version: string): Promise<void>;
  keepInstalled(): void;
  checkHardware(): Promise<void>;
}

export function createAnalyticsPackStore(
  b: Bridge,
  on: AioBridge['on'] | undefined,
): StoreApi<AnalyticsPack> {
  let following = false;
  return createStore<AnalyticsPack>()((set, get) => {
    const readStatus = async () => {
      const r = await b.call('analyticsPack:status', {});
      if (!r.ok) set({ error: r.error });
      else set({ status: r.value, offer: r.value.offer });
    };
    return {
      status: null,
      offer: null,
      progress: null,
      installing: false,
      error: null,
      note: null,
      replace: null,
      hardware: null,
      checking: false,

      load: async () => {
        if (!following && on) {
          following = true;
          // only the install this window started: main does not say whether one runs
          on('analyticsPack:progress', (p) => {
            if (get().installing) set({ progress: p });
          });
        }
        await Promise.all([readStatus(), get().checkHardware()]);
      },

      choose: async () => {
        const r = await b.call('analyticsPack:choose', {});
        if (!r.ok) set({ error: r.error });
        else if (r.value.path) await get().install(r.value.path);
      },

      install: async (path, replace) => {
        if (get().installing) return;
        set({ installing: true, progress: null, error: null, note: null, replace: null });
        const r = await b.call('analyticsPack:install', {
          path,
          ...(replace === true ? { replace } : {}),
        });
        set({ installing: false, progress: null });
        if (!r.ok) {
          set({ error: r.error });
          return;
        }
        const v = r.value;
        if (v.ok) {
          set({ note: { kind: 'installed', version: v.version }, offer: null });
          await readStatus();
        } else if (v.code === 'exists' && v.version !== undefined) {
          set({ replace: { path, version: v.version } });
        } else if (v.code !== 'cancelled') {
          // `cancelled` is also an unsigned pack the person turned down in main's dialog
          set({ error: v.error });
        }
      },

      cancel: () => {
        void b.call('analyticsPack:cancel', {});
      },

      remove: async (version) => {
        set({ error: null, note: null });
        const r = await b.call('analyticsPack:remove', { version });
        if (!r.ok) set({ error: r.error });
        else if (!r.value.ok) set({ error: r.value.error ?? null });
        else {
          set({ note: { kind: 'removed', version } });
          await readStatus();
        }
      },

      keepInstalled: () => {
        set({ replace: null });
      },

      checkHardware: async () => {
        set({ checking: true });
        const r = await b.call('analytics:hardware', {});
        set(r.ok ? { hardware: r.value, checking: false } : { error: r.error, checking: false });
      },
    };
  });
}
