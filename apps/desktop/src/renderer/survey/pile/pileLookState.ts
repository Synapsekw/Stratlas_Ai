/**
 * Which pile the main 3D view draws as the opened "glass box" (`pileLookScene`), and what of it
 * takes a click. The measurement layer leaves that pile's outline, fill and points to the box
 * (`measureScene`), the pick reads the box's top and sides (`measurePick`).
 *
 * `pinned` is the one input: the volumetric report sets it to picture a pile on a survey date.
 * Everything else is written by the scene.
 */
import { createStore } from 'zustand/vanilla';
import type { HitShape } from '../measureHits';

/** A pile whose box is drawn as it is on one survey date, whatever is focused or on screen. */
export interface PinnedPile {
  /** The measurement's id. */
  id: string;
  /** The survey date (capture id) its surface and outline are read on. */
  capture: string;
}

export interface PileLookState {
  /** The measurement drawn as the box now; null while none is (not opened, edited, loading). */
  shown: string | null;
  /**
   * The survey date the drawn box was sampled on, null with no box (or no date to name). It tells
   * the box of a wanted date from an earlier one still on screen while the new one is sampled.
   */
  shownOn: string | null;
  /** Its lifted top and each side, as the hit test reads shapes. */
  hits: readonly HitShape[];
  /** Report only: draw this pile's box on this date (`lookTarget`). Null in normal use. */
  pinned: PinnedPile | null;
}

export const pileLookState = createStore<PileLookState>()(() => ({
  shown: null,
  shownOn: null,
  hits: [],
  pinned: null,
}));

/** Whether the main 3D view draws `id` as the opened box (its own outline is then left out). */
export function pileLookOwns(id: string): boolean {
  return pileLookState.getState().shown === id;
}

/** The opened box's top and sides for the 3D pick; none while no box shows. */
export function openPileHits(): readonly HitShape[] {
  return pileLookState.getState().hits;
}
