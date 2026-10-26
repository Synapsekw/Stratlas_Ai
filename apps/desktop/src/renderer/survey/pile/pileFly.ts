/**
 * The camera's move to an opened pile (founder, 26 Oct 2026): an oblique view framing the whole
 * pile. `openPile` asks for it; the main 3D view (`pileLookScene`) answers once the pile's box is
 * built, as only it knows how high the box stands and whether the pile is already in view.
 */
import { createStore } from 'zustand/vanilla';

/**
 * How an open moves the camera: `always` (the sidebar, the inventory, the map, the panel's
 * arrows), `if-out-of-view` (a click on the pile in 3D: it was in view to be clicked) or `never`.
 */
export type PileFlyMode = 'always' | 'if-out-of-view' | 'never';

export interface PileFlyAsk {
  id: string;
  /** Only when the pile is not already mostly in view. */
  onlyIfOutOfView: boolean;
  seq: number;
}

export const pileFly = createStore<{ ask: PileFlyAsk | null }>()(() => ({ ask: null }));

let seq = 0;

/** Ask the 3D view to frame the pile `id` (nothing for `never`). */
export function askPileFly(id: string, mode: PileFlyMode = 'always'): void {
  if (mode === 'never') return;
  seq += 1;
  pileFly.setState({ ask: { id, onlyIfOutOfView: mode === 'if-out-of-view', seq } });
}
