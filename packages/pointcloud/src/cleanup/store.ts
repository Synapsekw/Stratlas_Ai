/**
 * The cleanup recipes the viewer shows, by layer id. The app's cleanup store
 * (apps/desktop/src/renderer/pointcloud/cleanupStore.ts) owns history and saving and pushes the
 * current recipe here; CloudManager and the adapter (Task 6) follow it. A drag of the clip box
 * pushes live values here without an undo step.
 */
import type { PointcloudCleanup } from '@aio/schema';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface CleanupRecipes {
  recipes: Readonly<Record<string, PointcloudCleanup>>;
  set(layerId: string, recipe: PointcloudCleanup | null): void;
  clear(): void;
}

export function createCleanupRecipes(): StoreApi<CleanupRecipes> {
  return createStore<CleanupRecipes>()((set) => ({
    recipes: {},
    set: (layerId, recipe) => {
      set((s) => ({
        recipes: recipe
          ? { ...s.recipes, [layerId]: recipe }
          : Object.fromEntries(Object.entries(s.recipes).filter(([id]) => id !== layerId)),
      }));
    },
    clear: () => {
      set({ recipes: {} });
    },
  }));
}

export const pointcloudCleanup = createCleanupRecipes();
