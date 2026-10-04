import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { parsePinFilter, type PinFilter } from './declutter';

/** How issues are drawn over the 3D scene and the map (a per-machine view preference). */
export interface PinDisplayState {
  /** Pins: all, none, or severity at or above a level. */
  filter: PinFilter;
  /** Severity density heat map on surfaces (3D) and ground (map). */
  heat: boolean;
  setFilter(f: PinFilter): void;
  setHeat(on: boolean): void;
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

const KEY = 'aio.annotate.pins';

function read(storage: KeyValue | null): { filter: PinFilter; heat: boolean } {
  try {
    const raw = storage?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as { filter?: unknown; heat?: unknown }) : {};
    const f =
      typeof v.filter === 'number' || typeof v.filter === 'string' ? String(v.filter) : null;
    return { filter: parsePinFilter(f), heat: v.heat === true };
  } catch {
    return { filter: 'all', heat: false };
  }
}

/** A pin display store over `storage` (null: nothing is remembered). */
export function createPinDisplay(storage: KeyValue | null): StoreApi<PinDisplayState> {
  const save = (s: { filter: PinFilter; heat: boolean }) => {
    try {
      storage?.setItem(KEY, JSON.stringify({ filter: s.filter, heat: s.heat }));
    } catch {
      // private window or blocked storage: the setting lasts for the session only
    }
  };
  return createStore<PinDisplayState>()((set, get) => ({
    ...read(storage),
    setFilter: (filter) => {
      set({ filter });
      save(get());
    },
    setHeat: (heat) => {
      set({ heat });
      save(get());
    },
  }));
}

function browserStorage(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The app-wide pin display, remembered in the renderer's local storage. */
export const pinDisplay = createPinDisplay(browserStorage());

export function usePinDisplay<T>(selector: (s: PinDisplayState) => T): T {
  return useStore(pinDisplay, selector);
}
