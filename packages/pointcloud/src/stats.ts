import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export interface CloudCounts {
  /** Points on screen (visible layers). */
  loaded: number;
  /** Points known across every chunk of every layer. */
  total: number;
  /** Chunks being decoded. */
  loading: number;
  layers: number;
  /** Some cloud carries RGB colour (png-packed ones are assumed to before they decode). */
  rgb: boolean;
  /** Height range of the loaded, visible points in the local frame (Y up), metres. */
  heightRange: readonly [number, number] | null;
}

interface StatsState {
  byScene: Map<object, CloudCounts>;
  errors: string[];
  setCounts(scene: object, c: CloudCounts): void;
  forget(scene: object): void;
  addError(message: string): void;
}

function sameRange(a: CloudCounts['heightRange'], b: CloudCounts['heightRange']): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
}

/** Live point-cloud counters for the controls and status bars. */
export const pointcloudStats = createStore<StatsState>()((set) => ({
  byScene: new Map(),
  errors: [],
  setCounts: (scene, c) => {
    set((s) => {
      const prev = s.byScene.get(scene);
      if (
        prev?.loaded === c.loaded &&
        prev.total === c.total &&
        prev.loading === c.loading &&
        prev.layers === c.layers &&
        prev.rgb === c.rgb &&
        sameRange(prev.heightRange, c.heightRange)
      ) {
        return s;
      }
      const byScene = new Map(s.byScene);
      byScene.set(scene, c);
      return { byScene };
    });
  },
  forget: (scene) => {
    set((s) => {
      const byScene = new Map(s.byScene);
      byScene.delete(scene);
      return { byScene };
    });
  },
  addError: (message) => {
    set((s) => ({ errors: [...s.errors.slice(-9), message] }));
  },
}));

export function totalCounts(byScene: Map<object, CloudCounts>): CloudCounts {
  const out: CloudCounts = {
    loaded: 0,
    total: 0,
    loading: 0,
    layers: 0,
    rgb: false,
    heightRange: null,
  };
  for (const c of byScene.values()) {
    out.loaded += c.loaded;
    out.total += c.total;
    out.loading += c.loading;
    out.layers += c.layers;
    out.rgb ||= c.rgb;
    const h = c.heightRange;
    if (h)
      out.heightRange = out.heightRange
        ? [Math.min(out.heightRange[0], h[0]), Math.max(out.heightRange[1], h[1])]
        : h;
  }
  return out;
}

export function usePointcloudCounts(): CloudCounts {
  const byScene = useStore(pointcloudStats, (s) => s.byScene);
  return useMemo(() => totalCounts(byScene), [byScene]);
}
