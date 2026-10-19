import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

/** One "Compare with previous survey" request: the polygon and the pair it compares. */
export interface AreaCompareRequest {
  measurementId: string;
  from: string;
  to: string;
}

export interface AreaCompareState {
  request: AreaCompareRequest | null;
  ask(req: AreaCompareRequest): void;
  close(): void;
}

/** The open confirm box of an area compare (null: none). */
export const areaCompare = createStore<AreaCompareState>((set) => ({
  request: null,
  ask: (req) => {
    set({ request: req });
  },
  close: () => {
    set({ request: null });
  },
}));

export function useAreaCompare<T>(selector: (s: AreaCompareState) => T): T {
  return useStore(areaCompare, selector);
}

export const VOLUMES_KEY = 'stratlas.areaCompare.volumes';

/** The last "Include volumes" choice on this computer; off when never set or unreadable. */
export function volumesPref(): boolean {
  try {
    return localStorage.getItem(VOLUMES_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember the "Include volumes" choice on this computer (ignored when storage is blocked). */
export function setVolumesPref(on: boolean): void {
  try {
    localStorage.setItem(VOLUMES_KEY, on ? '1' : '0');
  } catch {
    // storage blocked: the choice is only for this run
  }
}
