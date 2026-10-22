import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * The project clock at full rate: playback writes it on every frame (the video's presented frames,
 * else every animation frame). It lives apart from the workspace store so a playback frame wakes
 * only what follows the clock (the playhead, the video sync, the 3D drone and projector), not every
 * workspace subscriber. The workspace keeps `nowMs` too: exact after every seek and pause, and
 * updated about COMMIT_HZ times a second while playing.
 */
export interface ClockState {
  /** Project clock, UTC milliseconds. */
  nowMs: number;
}

export type ClockStore = StoreApi<ClockState>;

/** How often a playing clock is written into the workspace store (wall clock, any rate). */
export const COMMIT_HZ = 15;
export const COMMIT_MS = 1000 / COMMIT_HZ;

export function createClock(nowMs = 0): ClockStore {
  return createStore<ClockState>()(() => ({ nowMs }));
}

/** Whether a playback tick to `nextMs` is written into the workspace store (`committedMs`). */
export function shouldCommit(
  committedMs: number,
  nextMs: number,
  playing: boolean,
  rate: number,
): boolean {
  if (!playing) return true;
  return Math.abs(nextMs - committedMs) >= COMMIT_MS * Math.max(rate, 0);
}

/** Anything with a `nowMs` the clock follows (the workspace store). */
interface ClockOwner {
  getState(): { nowMs: number };
  subscribe(listener: (s: { nowMs: number }, prev: { nowMs: number }) => void): () => void;
}

const clocks = new WeakMap<object, ClockStore>();

/** Registers the clock a workspace store writes (createWorkspace does). */
export function bindClock(owner: object, clock: ClockStore): void {
  clocks.set(owner, clock);
}

/**
 * The full-rate clock of a workspace store. A store not made by createWorkspace (a test double)
 * gets a clock that follows its `nowMs`.
 */
export function clockOf(owner: ClockOwner): ClockStore {
  let c = clocks.get(owner);
  if (!c) {
    const made = createClock(owner.getState().nowMs);
    owner.subscribe((s) => {
      if (made.getState().nowMs !== s.nowMs) made.setState({ nowMs: s.nowMs });
    });
    clocks.set(owner, made);
    c = made;
  }
  return c;
}

/** The exact project clock now (also while playing, when the workspace's `nowMs` lags a little). */
export function nowOf(owner: ClockOwner): number {
  return clockOf(owner).getState().nowMs;
}
