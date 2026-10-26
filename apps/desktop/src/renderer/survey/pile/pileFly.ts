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

/** What the 3D view does with a fly ask: frame the box, frame an estimate, wait for the box, or drop it. */
export type FlyStep = 'box' | 'estimate' | 'wait' | 'drop';

/**
 * The step for an ask, now (`deferred` false: the ask has just come) or later (`deferred`: the
 * wait for the box ended). The camera never moves under an edit that began after the ask: an ask
 * made with the edit already on frames the flat outline at once, a deferred one is dropped.
 */
export function flyStep(o: { boxShown: boolean; editing: boolean; deferred: boolean }): FlyStep {
  if (o.editing) return o.deferred ? 'drop' : 'estimate';
  if (o.boxShown) return 'box';
  return o.deferred ? 'estimate' : 'wait';
}

/** One sample in flight at a time: a result counts only if it is still the one wanted. */
export interface SampleGate {
  /** Start sampling `key`; false when it is already in flight. */
  start(key: string): boolean;
  /** A result for `key` arrived: true when it is still wanted (and the gate is free again). */
  settle(key: string): boolean;
  /** Sampling `key` failed. */
  fail(key: string): void;
  /** The wanted key is already sampled: anything in flight is no longer wanted. */
  reuse(): void;
}

export function sampleGate(): SampleGate {
  let pending = '';
  return {
    start: (key) => {
      if (pending === key) return false;
      pending = key;
      return true;
    },
    settle: (key) => {
      if (pending !== key) return false;
      pending = '';
      return true;
    },
    fail: (key) => {
      if (pending === key) pending = '';
    },
    reuse: () => {
      pending = '';
    },
  };
}
