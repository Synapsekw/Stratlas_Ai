/**
 * Which pile the main 3D view draws as the opened "glass box" (`pileLookScene`), and what of it
 * takes a click. The measurement layer leaves that pile's outline, fill and points to the box
 * (`measureScene`), the pick reads the box's top and sides (`measurePick`).
 */
import { createStore } from 'zustand/vanilla';
import type { HitShape } from '../measureHits';

export interface PileLookState {
  /** The measurement drawn as the box now; null while none is (not opened, edited, loading). */
  shown: string | null;
  /** Its lifted top and each side, as the hit test reads shapes. */
  hits: readonly HitShape[];
}

export const pileLookState = createStore<PileLookState>()(() => ({ shown: null, hits: [] }));

/** Whether the main 3D view draws `id` as the opened box (its own outline is then left out). */
export function pileLookOwns(id: string): boolean {
  return pileLookState.getState().shown === id;
}

/** The opened box's top and sides for the 3D pick; none while no box shows. */
export function openPileHits(): readonly HitShape[] {
  return pileLookState.getState().hits;
}
