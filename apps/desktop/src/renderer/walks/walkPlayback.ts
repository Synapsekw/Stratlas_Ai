import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/*
 * The walk the 360 pane is playing and where it is (seconds), so the map and the drawings can
 * show where a placed walk is while it plays (design W3). The pane writes it on every time tick
 * and seek and clears it when it closes or switches walk; null while no walk plays.
 */

export interface WalkPlaybackState {
  layerId: string | null;
  t: number | null;
}

export const walkPlayback = createStore<WalkPlaybackState>()(() => ({ layerId: null, t: null }));

/** The 360 pane shows walk `layerId` at `t` seconds. */
export function setWalkPlayback(layerId: string, t: number): void {
  const s = walkPlayback.getState();
  if (s.layerId !== layerId || s.t !== t) walkPlayback.setState({ layerId, t });
}

/** The pane of walk `layerId` closed or switched walk; another walk's time stays. */
export function clearWalkPlayback(layerId: string): void {
  if (walkPlayback.getState().layerId === layerId)
    walkPlayback.setState({ layerId: null, t: null });
}

export const useWalkPlayback = (): WalkPlaybackState => useStore(walkPlayback);
