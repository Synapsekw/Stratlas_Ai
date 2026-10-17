import { getActiveScene, onActiveScene, type SceneHandle } from '@aio/engine';
import { getActiveMap, onActiveMap, type MapController } from '@aio/maps';
import { useSyncExternalStore } from 'react';

/*
 * The 3D view and the map on screen. Read as external stores: the views come up in the same
 * commit as the menus and pin layers (the scene is set in the 3D view's effect, after their first
 * render and before their own effect would listen), and a store read again after subscribing does
 * not miss that.
 */
const subscribeScene = (cb: () => void) => onActiveScene(cb);
const subscribeMap = (cb: () => void) => onActiveMap(cb);

export function useScene(): SceneHandle | null {
  return useSyncExternalStore(subscribeScene, getActiveScene);
}

export function useMap(): MapController | null {
  return useSyncExternalStore(subscribeMap, getActiveMap);
}
