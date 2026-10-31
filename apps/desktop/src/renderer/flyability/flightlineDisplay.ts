import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/*
 * How the open project's flight lines are drawn (view state only): line width, one colour per
 * flight or a single colour, and whether only the selected flight shows. Remembered per project on
 * this machine; never written to the manifest.
 */

const KEY = 'quadrion.flightlineDisplay';

export const MIN_WIDTH_PX = 1;
export const MAX_WIDTH_PX = 8;
export const DEFAULT_WIDTH_PX = 3;
/** The colour of every line in "one colour" mode. */
export const ONE_COLOUR = 'var(--date-1)';

export interface FlightlineDisplay {
  widthPx: number;
  colourMode: 'flight' | 'one';
  /** Draw only the selected flight line (all of them while none is selected). */
  activeOnly: boolean;
}

export const DEFAULT_DISPLAY: FlightlineDisplay = {
  widthPx: DEFAULT_WIDTH_PX,
  colourMode: 'flight',
  activeOnly: false,
};

function clean(v: unknown): FlightlineDisplay {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const w = typeof o.widthPx === 'number' && Number.isFinite(o.widthPx) ? o.widthPx : null;
  return {
    widthPx:
      w === null ? DEFAULT_WIDTH_PX : Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, Math.round(w))),
    colourMode: o.colourMode === 'one' ? 'one' : 'flight',
    activeOnly: o.activeOnly === true,
  };
}

function parse(raw: string | null | undefined): Record<string, FlightlineDisplay> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).map(([id, d]) => [id, clean(d)]));
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

export interface FlightlineDisplayState {
  byProject: Record<string, FlightlineDisplay>;
  patch(projectId: string, change: Partial<FlightlineDisplay>): void;
}

export function createFlightlineDisplayStore(
  storage: Storage | null = browserStorage(),
): StoreApi<FlightlineDisplayState> {
  let initial: Record<string, FlightlineDisplay> = {};
  try {
    initial = parse(storage?.getItem(KEY));
  } catch {
    // blocked storage: start with the defaults
  }
  const store = createStore<FlightlineDisplayState>()((set, get) => ({
    byProject: initial,
    patch: (projectId, change) => {
      const now = get().byProject[projectId] ?? DEFAULT_DISPLAY;
      set({ byProject: { ...get().byProject, [projectId]: clean({ ...now, ...change }) } });
    },
  }));
  store.subscribe((s) => {
    try {
      storage?.setItem(KEY, JSON.stringify(s.byProject));
    } catch {
      // private window or blocked storage: the choice is just not remembered
    }
  });
  return store;
}

let shared: StoreApi<FlightlineDisplayState> | null = null;

/** The app's store, created on first use so importing this module reads no storage. */
export function flightlineDisplay(): StoreApi<FlightlineDisplayState> {
  shared ??= createFlightlineDisplayStore();
  return shared;
}

/** A project's display options (the defaults while none were chosen). */
export function useFlightlineDisplay(projectId: string | null): FlightlineDisplay {
  return useStore(flightlineDisplay(), (s) =>
    projectId === null ? DEFAULT_DISPLAY : (s.byProject[projectId] ?? DEFAULT_DISPLAY),
  );
}
