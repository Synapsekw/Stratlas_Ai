/**
 * The store behind Settings, Models and detection, Add-ons (see addons.ts for the app's instance):
 * the known add-ons with what is installed and what the catalogue offers, the one install that
 * runs (a download by id or a file chosen on an offline computer), errors per row and the answer
 * other features ask synchronously ("is the Ground classifier installed?"). No window and no
 * singleton here, so it runs in a unit test with a fake bridge. Modelled on analyticsPackStore.ts.
 */
import type {
  AddonInstallResult,
  AddonKind,
  AddonListResponse,
  AddonProgress,
  AddonStatus,
  AioBridge,
} from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Bridge } from './bridge';

/** The row a running install belongs to: an add-on id, or `file` until a chosen file names one. */
export interface AddonRunning {
  id: string | null;
  progress: AddonProgress | null;
}

export interface Addons {
  /** null until main answered. */
  list: AddonListResponse | null;
  /** The list could not be read: why. */
  listError: string | null;
  /** The install that runs; null when none does. */
  running: AddonRunning | null;
  /** Why the last install or removal of a row failed, by add-on id (`file` for a chosen file). */
  errors: Readonly<Record<string, string>>;
  /** What just happened, for a sentence on the row. */
  note: { id: string; kind: 'installed' | 'removed'; version: string } | null;
  /** Read the list (the catalogue too, unless offline only). */
  load(): Promise<void>;
  /** Read the list once (features that only ask what is installed call it). */
  ensure(): Promise<void>;
  install(id: string): Promise<void>;
  /** Pick an add-on file with the file dialog, then install it. */
  chooseFile(): Promise<void>;
  cancel(): void;
  remove(id: string): Promise<boolean>;
}

/** The installed add-on of a kind, or null (read synchronously by menus and panels). */
export function installedOf(s: Pick<Addons, 'list'>, kind: AddonKind): AddonStatus | null {
  return s.list?.addons.find((a) => a.kind === kind && a.installed !== null) ?? null;
}

export function createAddonsStore(b: Bridge, on: AioBridge['on'] | undefined): StoreApi<Addons> {
  let following = false;
  let loaded: Promise<void> | null = null;
  return createStore<Addons>()((set, get) => {
    const setError = (id: string, error: string | null) => {
      const rest = Object.fromEntries(Object.entries(get().errors).filter(([k]) => k !== id));
      set({ errors: error === null ? rest : { ...rest, [id]: error } });
    };
    const finish = async (
      key: string,
      r: { ok: true; value: AddonInstallResult } | { ok: false; error: string },
    ) => {
      const id = get().running?.id ?? key;
      set({ running: null });
      if (!r.ok) {
        setError(id, r.error);
        return;
      }
      const v = r.value;
      if (v.ok) {
        setError(id, null);
        setError(v.manifest.id, null);
        set({ note: { id: v.manifest.id, kind: 'installed', version: v.manifest.version } });
        await get().load();
      } else if (v.code !== 'cancelled') {
        setError(id, v.error);
      }
    };
    return {
      list: null,
      listError: null,
      running: null,
      errors: {},
      note: null,

      load: async () => {
        if (!following && on) {
          following = true;
          on('addons:progress', (p) => {
            const run = get().running;
            // an install this window did not start (another window) changes the list too
            if (!run) {
              if (p.phase === 'done') void get().load();
              return;
            }
            // a chosen file names its add-on with its first progress
            set({ running: { id: run.id ?? p.id, progress: p } });
          });
        }
        const r = await b.call('addons:list', {});
        if (!r.ok) set({ listError: r.error });
        else set({ list: r.value, listError: null });
      },

      ensure: () => {
        loaded ??= get().load();
        return loaded;
      },

      install: async (id) => {
        if (get().running) return;
        setError(id, null);
        set({ running: { id, progress: null }, note: null });
        await finish(id, await b.call('addons:install', { id }));
      },

      chooseFile: async () => {
        if (get().running) return;
        setError('file', null);
        const picked = await b.call('addons:choose', {});
        if (!picked.ok) {
          setError('file', picked.error);
          return;
        }
        const path = picked.value.path;
        if (!path) return;
        set({ running: { id: null, progress: null }, note: null });
        await finish('file', await b.call('addons:installFile', { path }));
      },

      cancel: () => {
        void b.call('addons:cancel', {});
      },

      remove: async (id) => {
        setError(id, null);
        set({ note: null });
        const version = get().list?.addons.find((a) => a.id === id)?.installed?.manifest.version;
        const r = await b.call('addons:remove', { id });
        const error = !r.ok ? r.error : r.value.ok ? null : r.value.error;
        if (error !== null) {
          setError(id, error);
          return false;
        }
        if (version !== undefined) set({ note: { id, kind: 'removed', version } });
        await get().load();
        return true;
      },
    };
  });
}
