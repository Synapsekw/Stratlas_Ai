import type { MapOverlay } from '@aio/maps';
import type { Vec3 } from '@aio/schema';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/*
 * What the walks put on the main map pane: their overlays (`walkMapOverlays`) and, while a walk is
 * being placed on the map, a one-shot point pick. The stage's map pane reads it and merges the
 * overlays with its own; whoever owns the walk fits (Place walk, the walk mounts) writes it.
 */

/** A one-shot point pick on the map, as `MapView`'s `pick` prop takes it. */
export interface WalkMapPick {
  onPick: (local: Vec3) => void;
  onCancel?: () => void;
}

export interface WalkMapState {
  overlays: readonly MapOverlay[];
  pick: WalkMapPick | null;
}

const NONE: readonly MapOverlay[] = [];

export const walkMap = createStore<WalkMapState>()(() => ({ overlays: NONE, pick: null }));

/** Replace the walks' map overlays (an empty list clears them). */
export function setWalkMapOverlays(overlays: readonly MapOverlay[]): void {
  walkMap.setState({ overlays: overlays.length === 0 ? NONE : overlays });
}

/** Arm (or with null, disarm) the map point pick; it clears itself once it reports or cancels. */
export function setWalkMapPick(pick: WalkMapPick | null): void {
  if (!pick) {
    walkMap.setState({ pick: null });
    return;
  }
  const armed: WalkMapPick = {
    onPick: (local) => {
      if (walkMap.getState().pick === armed) walkMap.setState({ pick: null });
      pick.onPick(local);
    },
    onCancel: () => {
      if (walkMap.getState().pick === armed) walkMap.setState({ pick: null });
      pick.onCancel?.();
    },
  };
  walkMap.setState({ pick: armed });
}

export const useWalkMapOverlays = (): readonly MapOverlay[] => useStore(walkMap, (s) => s.overlays);
export const useWalkMapPick = (): WalkMapPick | null => useStore(walkMap, (s) => s.pick);
