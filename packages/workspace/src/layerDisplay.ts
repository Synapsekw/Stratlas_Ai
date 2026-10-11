import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * How a layer lies over the others in the 3D view and on the map, beyond shown or hidden. View
 * state only: the app remembers it per project on this computer and mirrors it here; the 3D view
 * and the map read it. Today it applies to drawings (plan rasters).
 */
export interface LayerDisplay {
  /** 0 (clear) to 1 (solid). Absent: the view's own default. */
  opacity?: number;
  /** Drawn over models and point clouds in 3D instead of being hidden by them. */
  onTop?: boolean;
}

/** A display choice read from storage or a patch: clamped, unknown values dropped. */
export function cleanLayerDisplay(v: unknown): LayerDisplay {
  if (!v || typeof v !== 'object') return {};
  const raw = v as Record<string, unknown>;
  const out: LayerDisplay = {};
  if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity))
    out.opacity = Math.min(1, Math.max(0, raw.opacity));
  if (raw.onTop === true) out.onTop = true;
  return out;
}

export interface LayerDisplayState {
  byLayer: Readonly<Record<string, LayerDisplay>>;
  /** The choices of the project that just opened (none: `{}`). */
  replace(all: Readonly<Record<string, unknown>>): void;
  /** Merge a change into one layer's choice. */
  set(layerId: string, patch: LayerDisplay): void;
}

export function createLayerDisplay(): StoreApi<LayerDisplayState> {
  return createStore<LayerDisplayState>()((set, get) => ({
    byLayer: {},
    replace: (all) => {
      const next: Record<string, LayerDisplay> = {};
      for (const [id, d] of Object.entries(all)) {
        const clean = cleanLayerDisplay(d);
        if (Object.keys(clean).length > 0) next[id] = clean;
      }
      if (JSON.stringify(next) !== JSON.stringify(get().byLayer)) set({ byLayer: next });
    },
    set: (layerId, patch) => {
      const byLayer = { ...get().byLayer };
      const clean = cleanLayerDisplay({ ...byLayer[layerId], ...patch });
      if (Object.keys(clean).length > 0) byLayer[layerId] = clean;
      else Reflect.deleteProperty(byLayer, layerId);
      set({ byLayer });
    },
  }));
}

/** The app-wide store. Tests create their own with `createLayerDisplay()`. */
export const layerDisplay = createLayerDisplay();

export function useLayerDisplay<T>(selector: (s: LayerDisplayState) => T): T {
  return useStore(layerDisplay, selector);
}
