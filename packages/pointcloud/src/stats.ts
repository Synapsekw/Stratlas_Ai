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
}

interface StatsState {
  byScene: Map<object, CloudCounts>;
  errors: string[];
  setCounts(scene: object, c: CloudCounts): void;
  forget(scene: object): void;
  addError(message: string): void;
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
        prev.layers === c.layers
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
  const out: CloudCounts = { loaded: 0, total: 0, loading: 0, layers: 0 };
  for (const c of byScene.values()) {
    out.loaded += c.loaded;
    out.total += c.total;
    out.loading += c.loading;
    out.layers += c.layers;
  }
  return out;
}

export function usePointcloudCounts(): CloudCounts {
  const byScene = useStore(pointcloudStats, (s) => s.byScene);
  return totalCounts(byScene);
}
