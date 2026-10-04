import type { EnvironmentSettings } from '@aio/engine';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * The stage environment the user chose, per project: backdrop, time of day, water toggle and
 * level. Only what was changed is kept; the rest comes from the engine's defaults for the
 * project (`defaultEnvironment`), so a new capture date or data update still shows through.
 */
export type EnvPref = Partial<EnvironmentSettings>;

const KEY = 'stratlas.environment';

/** Keep only well-formed fields: storage may hold anything. */
export function cleanPref(v: unknown): EnvPref {
  if (typeof v !== 'object' || v === null) return {};
  const p = v as Record<string, unknown>;
  const out: EnvPref = {};
  if (p.mode === 'sky' || p.mode === 'studio') out.mode = p.mode;
  if (typeof p.timeMs === 'number' && Number.isFinite(p.timeMs)) out.timeMs = p.timeMs;
  if (typeof p.water === 'boolean') out.water = p.water;
  if (p.waterLevel === null || (typeof p.waterLevel === 'number' && Number.isFinite(p.waterLevel)))
    out.waterLevel = p.waterLevel;
  return out;
}

export function parsePrefs(raw: string | null | undefined): Record<string, EnvPref> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return {};
    const out: Record<string, EnvPref> = {};
    for (const [id, p] of Object.entries(v)) {
      const c = cleanPref(p);
      if (Object.keys(c).length > 0) out[id] = c;
    }
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

export interface EnvPrefState {
  byProject: Record<string, EnvPref>;
  /** Merge a change into the project's choice. */
  set(projectId: string, patch: EnvPref): void;
  /** Forget the project's choice (back to the defaults). */
  reset(projectId: string): void;
}

/** Environment choices, remembered per project on this workstation. */
export function createEnvPrefs(storage: Storage | null = browserStorage()): StoreApi<EnvPrefState> {
  let initial: Record<string, EnvPref> = {};
  try {
    initial = parsePrefs(storage?.getItem(KEY));
  } catch {
    // blocked storage: start with the defaults
  }
  const store = createStore<EnvPrefState>()((set, get) => ({
    byProject: initial,
    set: (projectId, patch) => {
      const next = { ...get().byProject[projectId], ...cleanPref(patch) };
      set({ byProject: { ...get().byProject, [projectId]: next } });
    },
    reset: (projectId) => {
      set({
        byProject: Object.fromEntries(
          Object.entries(get().byProject).filter(([id]) => id !== projectId),
        ),
      });
    },
  }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  store.subscribe((s) => {
    // dragging the time slider changes this many times a second: write once it settles
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        storage?.setItem(KEY, JSON.stringify(s.byProject));
      } catch {
        // private window or blocked storage: the choice is just not remembered
      }
    }, 250);
  });
  return store;
}

export const envPrefs = createEnvPrefs();

export function useEnvPrefs<T>(selector: (s: EnvPrefState) => T): T {
  return useStore(envPrefs, selector);
}
