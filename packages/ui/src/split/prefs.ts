import { createStore, type StoreApi } from 'zustand/vanilla';

/** A split's remembered size (px, or a 0..1 fraction) and whether it is collapsed. */
export interface SplitPref {
  size: number;
  collapsed?: boolean;
}

export interface SplitPrefsState {
  byId: Record<string, SplitPref>;
  save(id: string, pref: SplitPref): void;
}

/** Storage key of every split's size, per computer (not per project). */
export const SPLIT_PREFS_KEY = 'quadrion.splits';

type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function isPref(v: unknown): v is SplitPref {
  if (typeof v !== 'object' || v === null) return false;
  const { size, collapsed } = v as Record<string, unknown>;
  return (
    typeof size === 'number' &&
    Number.isFinite(size) &&
    (collapsed === undefined || typeof collapsed === 'boolean')
  );
}

/** What `storage` holds; anything unreadable or malformed is dropped. */
function read(storage: PrefsStorage | null): Record<string, SplitPref> {
  try {
    const raw = storage?.getItem(SPLIT_PREFS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, SplitPref> = {};
    for (const [id, pref] of Object.entries(parsed)) {
      if (isPref(pref)) out[id] = pref;
    }
    return out;
  } catch {
    return {};
  }
}

function browserStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * A split prefs store on `storage` (default `localStorage`; `null` keeps it in memory). Blocked or
 * full storage never loses a value for the session: it stays in memory.
 */
export function createSplitPrefs(
  storage: PrefsStorage | null = browserStorage(),
): StoreApi<SplitPrefsState> {
  return createStore<SplitPrefsState>((set, get) => ({
    byId: read(storage),
    save(id, pref) {
      const byId = { ...get().byId, [id]: pref };
      set({ byId });
      try {
        storage?.setItem(SPLIT_PREFS_KEY, JSON.stringify(byId));
      } catch {
        // blocked or full: the size still holds for this session
      }
    },
  }));
}

/** The app's split prefs, on localStorage. */
export const splitPrefs: StoreApi<SplitPrefsState> = createSplitPrefs();
