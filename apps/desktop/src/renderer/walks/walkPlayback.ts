import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

/*
 * The walk the 360 pane is playing and where it is (seconds), so the map and the drawings can
 * show where a placed walk is while it plays (design W3). The pane writes it as soon as the video
 * has loaded, on every time tick and seek, and clears it when it closes or switches walk; null
 * while no walk plays.
 */

export interface WalkPlaybackState {
  layerId: string | null;
  t: number | null;
}

const NONE: WalkPlaybackState = { layerId: null, t: null };

export const walkPlayback = createStore<WalkPlaybackState>()(() => NONE);

/** The 360 pane shows walk `layerId` at `t` seconds. */
export function setWalkPlayback(layerId: string, t: number): void {
  const s = walkPlayback.getState();
  if (s.layerId !== layerId || s.t !== t) walkPlayback.setState({ layerId, t });
}

/** The pane of walk `layerId` closed or switched walk; another walk's time stays. */
export function clearWalkPlayback(layerId: string): void {
  if (walkPlayback.getState().layerId === layerId) walkPlayback.setState(NONE);
}

/** The part of the pane's video element the playback follows. */
export interface PlaybackVideo {
  readonly currentTime: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

const VIDEO_EVENTS = ['loadeddata', 'timeupdate', 'seeked'] as const;

/**
 * Publish where video `v` of walk `layerId` is: once it has loaded (a walk opened paused shows
 * its dot at once), then on every time tick and seek. The returned stop clears it (the pane
 * closed or switched walk).
 */
export function publishWalkPlayback(v: PlaybackVideo, layerId: string): () => void {
  const write = () => {
    setWalkPlayback(layerId, v.currentTime);
  };
  for (const e of VIDEO_EVENTS) v.addEventListener(e, write);
  return () => {
    for (const e of VIDEO_EVENTS) v.removeEventListener(e, write);
    clearWalkPlayback(layerId);
  };
}

/** `s` while it plays a walk `shown` keeps, else none: other walks' ticks change nothing. */
export function playbackAmong(
  s: WalkPlaybackState,
  shown: (layerId: string) => boolean,
): WalkPlaybackState {
  return s.layerId !== null && shown(s.layerId) ? s : NONE;
}

/**
 * Calls `draw` now and again only when the playback of a walk `shown` keeps changes (its time,
 * or a walk starting or stopping), without rendering anything. Returns the unsubscribe.
 */
export function watchWalkPlayback(
  shown: (layerId: string) => boolean,
  draw: (playing: WalkPlaybackState) => void,
): () => void {
  let last = playbackAmong(walkPlayback.getState(), shown);
  draw(last);
  return walkPlayback.subscribe((s) => {
    const next = playbackAmong(s, shown);
    if (next.layerId === last.layerId && next.t === last.t) return;
    last = next;
    draw(next);
  });
}

/** The playback while it plays one of `shown`: a component re-renders for those walks only. */
export function useWalkPlaybackAmong(shown: ReadonlySet<string>): WalkPlaybackState {
  const has = (id: string) => shown.has(id);
  const layerId = useStore(walkPlayback, (s) => playbackAmong(s, has).layerId);
  const t = useStore(walkPlayback, (s) => playbackAmong(s, has).t);
  return useMemo(() => ({ layerId, t }), [layerId, t]);
}
