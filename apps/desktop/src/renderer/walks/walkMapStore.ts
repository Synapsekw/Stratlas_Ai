import type { MapOverlay, MapPointerSession } from '@aio/maps';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/*
 * What the walks put on the main map pane: their overlays (`walkMapOverlays`) and, while a walk is
 * being placed on the map, a pointer session (hover, clicks, handles). The stage's map pane reads
 * it and merges the overlays with its own; whoever owns the walk fits (Place walk, the walk
 * mounts) writes it.
 */

export interface WalkMapState {
  overlays: readonly MapOverlay[];
  /** The Place walk pointer session (one object for the life of a session on the map), or null. */
  pointer: MapPointerSession | null;
}

const NONE: readonly MapOverlay[] = [];

export const walkMap = createStore<WalkMapState>()(() => ({ overlays: NONE, pointer: null }));

/** Replace the walks' map overlays (an empty list clears them). */
export function setWalkMapOverlays(overlays: readonly MapOverlay[]): void {
  walkMap.setState({ overlays: overlays.length === 0 ? NONE : overlays });
}

/** Set (or with null, clear) the map pointer session of the walk being placed. */
export function setWalkMapPointer(p: MapPointerSession | null): void {
  if (walkMap.getState().pointer !== p) walkMap.setState({ pointer: p });
}

export const useWalkMapOverlays = (): readonly MapOverlay[] => useStore(walkMap, (s) => s.overlays);
export const useWalkMapPointer = (): MapPointerSession | null =>
  useStore(walkMap, (s) => s.pointer);
