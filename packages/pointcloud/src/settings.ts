import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type ColourMode = 'rgb' | 'intensity' | 'height' | 'flight';

export const COLOUR_MODES: readonly { id: ColourMode; label: string }[] = [
  { id: 'rgb', label: 'RGB' },
  { id: 'intensity', label: 'Intensity' },
  { id: 'height', label: 'Height' },
  { id: 'flight', label: 'Per flight' },
];

export const BUDGETS = [1_000_000, 2_000_000, 4_000_000, 6_000_000, 8_000_000, 12_000_000] as const;
export const DEFAULT_BUDGET = 6_000_000;
export const SIZE_RANGE = [0.25, 4] as const;
const KEY = 'stratlas.pointcloud.settings';

export interface PointcloudSettingsState {
  colourMode: ColourMode;
  /** Multiplier on each cloud's base point size. */
  sizeScale: number;
  /** Global point budget across every cloud in the scene. */
  budget: number;
  edl: boolean;
  edlStrength: number;
  /** Largest on-screen point, CSS pixels. */
  maxPixels: number;
}

export interface PointcloudSettingsActions {
  setColourMode(mode: ColourMode): void;
  setSizeScale(scale: number): void;
  setBudget(points: number): void;
  setEdl(on: boolean): void;
  setEdlStrength(strength: number): void;
}

export type PointcloudSettings = PointcloudSettingsState & PointcloudSettingsActions;

const defaults: PointcloudSettingsState = {
  colourMode: 'rgb',
  sizeScale: 1,
  budget: DEFAULT_BUDGET,
  edl: true,
  edlStrength: 1,
  maxPixels: 24,
};

function restore(storage: Storage | null): Partial<PointcloudSettingsState> {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<PointcloudSettingsState> = {};
    if (COLOUR_MODES.some((m) => m.id === v.colourMode))
      out.colourMode = v.colourMode as ColourMode;
    if (typeof v.sizeScale === 'number') out.sizeScale = clampSize(v.sizeScale);
    if (typeof v.budget === 'number') out.budget = snapBudget(v.budget);
    if (typeof v.edl === 'boolean') out.edl = v.edl;
    if (typeof v.edlStrength === 'number') out.edlStrength = clampStrength(v.edlStrength);
    return out;
  } catch {
    return {};
  }
}

const clampSize = (s: number) => Math.min(SIZE_RANGE[1], Math.max(SIZE_RANGE[0], s));
const clampStrength = (s: number) => Math.min(4, Math.max(0.1, s));

function snapBudget(n: number): number {
  let best: number = DEFAULT_BUDGET;
  for (const b of BUDGETS) if (Math.abs(b - n) < Math.abs(best - n)) best = b;
  return best;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Point-cloud display settings. Remembered per machine in localStorage until Settings gains a
 * point-cloud section (see the S4 report: contract seam).
 */
export function createPointcloudSettings(
  storage: Storage | null = browserStorage(),
): StoreApi<PointcloudSettings> {
  const store = createStore<PointcloudSettings>()((set) => ({
    ...defaults,
    ...restore(storage),
    setColourMode: (colourMode) => {
      set({ colourMode });
    },
    setSizeScale: (s) => {
      set({ sizeScale: clampSize(s) });
    },
    setBudget: (n) => {
      set({ budget: snapBudget(n) });
    },
    setEdl: (edl) => {
      set({ edl });
    },
    setEdlStrength: (s) => {
      set({ edlStrength: clampStrength(s) });
    },
  }));
  store.subscribe((s) => {
    try {
      storage?.setItem(
        KEY,
        JSON.stringify({
          colourMode: s.colourMode,
          sizeScale: s.sizeScale,
          budget: s.budget,
          edl: s.edl,
          edlStrength: s.edlStrength,
        }),
      );
    } catch {
      // private window or blocked storage: the choice is just not remembered
    }
  });
  return store;
}

/** The app-wide settings store shared by every scene and the controls. */
export const pointcloudSettings = createPointcloudSettings();

export function usePointcloudSettings<T>(selector: (s: PointcloudSettings) => T): T {
  return useStore(pointcloudSettings, selector);
}
