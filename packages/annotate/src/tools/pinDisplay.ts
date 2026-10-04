import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { parsePinFilter, type PinFilter } from './declutter';

/** How issues are drawn over the 3D scene and the map (a per-machine view preference). */
export interface PinDisplayState {
  /** Pins: all, none, or severity at or above a level. */
  filter: PinFilter;
  /** Severity density heat map on surfaces (3D) and ground (map). */
  heat: boolean;
  /** The filter the one-click toggle turns the pins back on to. */
  lastOn: ShownFilter;
  setFilter(f: PinFilter): void;
  setHeat(on: boolean): void;
  /** Pins off, or back on to the last filter that showed them (toolbar button, I). */
  togglePins(): void;
}

export type ShownFilter = Exclude<PinFilter, 'off'>;

/** The one-click toggle: off, or back to the filter that last showed pins. */
export function togglePinFilter(filter: PinFilter, lastOn: ShownFilter): PinFilter {
  return filter === 'off' ? lastOn : 'off';
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>;

const KEY = 'aio.annotate.pins';

type Saved = Pick<PinDisplayState, 'filter' | 'heat' | 'lastOn'>;

const asText = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? String(v) : null);

function read(storage: KeyValue | null): Saved {
  try {
    const raw = storage?.getItem(KEY);
    const v = raw
      ? (JSON.parse(raw) as { filter?: unknown; heat?: unknown; lastOn?: unknown })
      : {};
    const filter = parsePinFilter(asText(v.filter));
    const last = parsePinFilter(asText(v.lastOn));
    const lastOn = filter !== 'off' ? filter : last === 'off' ? 'all' : last;
    return { filter, heat: v.heat === true, lastOn };
  } catch {
    return { filter: 'all', heat: false, lastOn: 'all' };
  }
}

/** A pin display store over `storage` (null: nothing is remembered). */
export function createPinDisplay(storage: KeyValue | null): StoreApi<PinDisplayState> {
  const save = (s: Saved) => {
    try {
      storage?.setItem(KEY, JSON.stringify({ filter: s.filter, heat: s.heat, lastOn: s.lastOn }));
    } catch {
      // private window or blocked storage: the setting lasts for the session only
    }
  };
  return createStore<PinDisplayState>()((set, get) => ({
    ...read(storage),
    setFilter: (filter) => {
      set(filter === 'off' ? { filter } : { filter, lastOn: filter });
      save(get());
    },
    togglePins: () => {
      const s = get();
      s.setFilter(togglePinFilter(s.filter, s.lastOn));
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
