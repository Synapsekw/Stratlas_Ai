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
  /**
   * Automatic elevation range of the visible clouds in the local frame (Y up), metres: the 1st to
   * 99th percentile of their point heights.
   */
  heightRange: readonly [number, number] | null;
  /** Lowest and highest sampled point height of the visible clouds, local Y, metres. */
  heightExtent?: readonly [number, number] | null;
  /** Points per ASPRS class among the loaded, visible points; null when no cloud has classes. */
  classes?: Readonly<Record<number, number>> | null;
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

function sameClasses(a: CloudCounts['classes'], b: CloudCounts['classes']): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[Number(k)] === b[Number(k)]);
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
        sameRange(prev.heightRange, c.heightRange) &&
        sameRange(prev.heightExtent ?? null, c.heightExtent ?? null) &&
        sameClasses(prev.classes, c.classes)
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
    heightExtent: null,
    classes: null,
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
    const e = c.heightExtent;
    if (e)
      out.heightExtent = out.heightExtent
        ? [Math.min(out.heightExtent[0], e[0]), Math.max(out.heightExtent[1], e[1])]
        : e;
    if (c.classes) {
      const merged: Record<number, number> = { ...(out.classes ?? {}) };
      for (const [k, n] of Object.entries(c.classes)) merged[+k] = (merged[+k] ?? 0) + n;
      out.classes = merged;
    }
  }
  return out;
}

export function usePointcloudCounts(): CloudCounts {
  const byScene = useStore(pointcloudStats, (s) => s.byScene);
  return useMemo(() => totalCounts(byScene), [byScene]);
}
