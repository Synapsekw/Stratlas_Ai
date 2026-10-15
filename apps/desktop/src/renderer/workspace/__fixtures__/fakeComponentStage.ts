import type { ComponentInfo } from '@aio/engine';
import { vi } from 'vitest';

/**
 * The part of an engine stage the component list and card use, for tests: components per layer,
 * the engine's hidden record (with change listeners) and whether a layer has loaded.
 */
export function fakeComponentStage(byLayer: Record<string, ComponentInfo[]> = {}) {
  const hidden = new Map<string, Set<string>>();
  const listeners = new Set<(layerId: string) => void>();
  const stage = {
    byLayer,
    loaded: true,
    components: vi.fn((layerId: string) => stage.byLayer[layerId] ?? []),
    layerLoaded: vi.fn(() => stage.loaded),
    hiddenNodes: (layerId: string) => [...(hidden.get(layerId) ?? [])],
    onHiddenNodes: (cb: (layerId: string) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    setNodeVisible: vi.fn((layerId: string, node: string, visible: boolean) => {
      const set = hidden.get(layerId) ?? new Set<string>();
      if (visible) set.delete(node);
      else set.add(node);
      hidden.set(layerId, set);
      for (const l of listeners) l(layerId);
      return true;
    }),
    reset() {
      hidden.clear();
      stage.loaded = true;
      stage.components.mockClear();
      stage.setNodeVisible.mockClear();
    },
  };
  return stage;
}
