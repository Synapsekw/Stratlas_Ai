import type { FlightPathMode } from '@aio/video';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** Flight paths in 3D, per project: which mode, the mode P returns to, and single hidden flights. */
export interface PathPref {
  mode: FlightPathMode;
  /** The mode P turns the paths back on to. */
  lastOn: Exclude<FlightPathMode, 'off'>;
  /** Flight ids (timeline flight groups) whose path the user hid from the sidebar. */
  hiddenFlights: string[];
}

/** A flight and the clips cut from it (the timeline's flight groups). */
export interface FlightRef {
  id: string;
  clips: string[];
}

export const PATH_MODES: { mode: FlightPathMode; label: string; hint: string }[] = [
  { mode: 'all', label: 'All', hint: 'Every flight path' },
  { mode: 'active', label: 'Active clip', hint: 'Only the flight of the active clip' },
  { mode: 'off', label: 'Off', hint: 'No flight paths; the drone and video stay' },
];

/** Above this many clips the paths clutter the site, so only the active flight draws. */
const MANY_CLIPS = 8;

export function defaultPathPref(clipCount: number): PathPref {
  const mode = clipCount > MANY_CLIPS ? 'active' : 'all';
  return { mode, lastOn: mode, hiddenFlights: [] };
}

/** P: paths off, or back on to the last mode that showed them. */
export function togglePaths(p: PathPref): PathPref {
  return p.mode === 'off' ? { ...p, mode: p.lastOn } : { ...p, mode: 'off', lastOn: p.mode };
}

export function setPathMode(p: PathPref, mode: FlightPathMode): PathPref {
  return { ...p, mode, lastOn: mode === 'off' ? p.lastOn : mode };
}

export function flightPathShown(p: PathPref, flightId: string, activeFlight: string | null) {
  if (p.mode === 'off' || p.hiddenFlights.includes(flightId)) return false;
  return p.mode === 'all' || flightId === activeFlight;
}

/** Clip ids of the hidden flights, for the 3D rig. */
export function hiddenPathClips(p: PathPref, flights: readonly FlightRef[]): Set<string> {
  const out = new Set<string>();
  for (const f of flights) if (p.hiddenFlights.includes(f.id)) for (const c of f.clips) out.add(c);
  return out;
}

/**
 * The eye on a flight row: hide a drawn path; draw a hidden one, keeping exactly the paths drawn
 * now plus this one (switching to All with the others hidden when the mode would not draw it).
 */
export function toggleFlightPath(
  p: PathPref,
  flightId: string,
  flights: readonly FlightRef[],
  activeFlight: string | null,
): PathPref {
  if (flightPathShown(p, flightId, activeFlight))
    return { ...p, hiddenFlights: [...p.hiddenFlights, flightId] };
  if (p.mode === 'all')
    return { ...p, hiddenFlights: p.hiddenFlights.filter((id) => id !== flightId) };
  const keep = new Set(
    flights.filter((f) => flightPathShown(p, f.id, activeFlight)).map((f) => f.id),
  );
  keep.add(flightId);
  return {
    mode: 'all',
    lastOn: 'all',
    hiddenFlights: flights.filter((f) => !keep.has(f.id)).map((f) => f.id),
  };
}

const KEY = 'stratlas.flightPaths';
const MODES: readonly FlightPathMode[] = ['all', 'active', 'off'];

function parse(raw: string | null | undefined): Record<string, PathPref> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as Record<string, Partial<PathPref>>;
    const out: Record<string, PathPref> = {};
    for (const [id, p] of Object.entries(v)) {
      if (!p.mode || !MODES.includes(p.mode)) continue;
      const lastOn = p.lastOn === 'all' || p.lastOn === 'active' ? p.lastOn : 'all';
      const hiddenFlights = Array.isArray(p.hiddenFlights)
        ? p.hiddenFlights.filter((x): x is string => typeof x === 'string')
        : [];
      out[id] = { mode: p.mode, lastOn, hiddenFlights };
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

export interface FlightPathState {
  byProject: Record<string, PathPref>;
  /** The project's choice, or the default for its clip count. */
  pref(projectId: string, clipCount: number): PathPref;
  set(projectId: string, p: PathPref): void;
}

/** Flight path choices, remembered per project on this machine. */
export function createFlightPathStore(
  storage: Storage | null = browserStorage(),
): StoreApi<FlightPathState> {
  let initial: Record<string, PathPref> = {};
  try {
    initial = parse(storage?.getItem(KEY));
  } catch {
    // blocked storage: start with the defaults
  }
  const store = createStore<FlightPathState>()((set, get) => ({
    byProject: initial,
    pref: (projectId, clipCount) => get().byProject[projectId] ?? defaultPathPref(clipCount),
    set: (projectId, p) => {
      set({ byProject: { ...get().byProject, [projectId]: p } });
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

export const flightPaths = createFlightPathStore();

export function useFlightPaths<T>(selector: (s: FlightPathState) => T): T {
  return useStore(flightPaths, selector);
}
