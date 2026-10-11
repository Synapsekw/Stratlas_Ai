import {
  chooseSide,
  resolveSplit,
  sideOf,
  type PaneKind,
  type SplitPref,
} from '../workspace/splitModel';

/* The 360 video pane without the DOM: time text, the player keys and where the pane opens. */

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatWalkTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h > 0 ? `${String(h)}:${p2(m)}:${p2(s % 60)}` : `${String(m)}:${p2(s % 60)}`;
}

/** What a key does to the player: play or pause, a playback rate, a step in seconds. */
export interface WalkKeyAction {
  play?: boolean;
  rate?: number;
  seekBy?: number;
}

/**
 * The keys of the video window (`VideoWindow` in `@aio/video`) for the 360 player: K pauses, L
 * plays and then doubles the speed, J slows down or steps back a second, comma and period or the
 * arrow keys step one frame. Space plays and pauses. Null for any other key.
 */
export function walkKeyAction(
  key: string,
  s: { playing: boolean; rate: number; fps: number },
): WalkKeyAction | null {
  const k = key.toLowerCase();
  const frame = 1 / (s.fps > 0 ? s.fps : 30);
  if (k === ' ') return s.playing ? { play: false } : { play: true, rate: 1 };
  if (k === 'k') return { play: false, rate: 1 };
  if (k === 'l') return s.playing ? { rate: Math.min(8, s.rate * 2) } : { play: true, rate: 1 };
  if (k === 'j')
    return s.playing && s.rate > 1 ? { rate: s.rate / 2 } : { play: false, seekBy: -1 };
  if (k === ',' || k === 'arrowleft') return { play: false, seekBy: -frame };
  if (k === '.' || k === 'arrowright') return { play: false, seekBy: frame };
  return null;
}

/**
 * Main has just answered an import (the import store's `cancellable` went from true to false).
 * The walk list is asked for again then, not when the import panel is free: an import stays
 * busy while a drawing's page question is open, and a walk must not wait for that answer.
 */
export function importAnswered(
  prev: { cancellable: boolean },
  next: { cancellable: boolean },
): boolean {
  return prev.cancellable && !next.cancellable;
}

/** The walk the pane shows: the chosen one while the project has it, else the first. */
export function pickWalk<T extends { id: string }>(
  walks: readonly T[],
  selected: string | null,
): T | undefined {
  return walks.find((w) => w.id === selected) ?? walks[0];
}

/** The split with the 360 video in it: where it already is, else on the right. */
export function splitWithWalk(
  saved: SplitPref | undefined,
  options: readonly PaneKind[],
): SplitPref {
  const sides = resolveSplit(saved, options);
  return sideOf(sides, 'walk360') ? sides : chooseSide(sides, 'right', 'walk360');
}
