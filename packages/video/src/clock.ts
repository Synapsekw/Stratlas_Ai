/**
 * Project clock <-> video time (docs/architecture/data-conventions.md section 3) and the pure
 * decisions of the playback controller. Video time `v` (s) maps to project time
 * `startUtcMs + offsetMs + v * 1000`.
 *
 * Sync rules: while the workspace is playing, the active clip's video is the clock master and
 * writes `nowMs` from requestVideoFrameCallback; other visible clips follow the clock and correct
 * drift. When paused or scrubbing, every video seeks to `nowMs`, clamped to its clip.
 */

export interface ClipTiming {
  /** Flight start, UTC ms (the video layer's `flight.startUtcMs`). */
  startUtcMs: number;
  /** Video layer `offsetMs`. */
  offsetMs: number;
  /** Video duration in seconds (NaN while unknown). */
  durationS: number;
}

export function clockForVideoTime(t: ClipTiming, videoS: number): number {
  return t.startUtcMs + t.offsetMs + videoS * 1000;
}

export function videoTimeForClock(t: ClipTiming, nowMs: number): number {
  return (nowMs - t.startUtcMs - t.offsetMs) / 1000;
}

export function clipWindow(t: ClipTiming): { startMs: number; endMs: number } {
  const startMs = clockForVideoTime(t, 0);
  return { startMs, endMs: clockForVideoTime(t, Number.isFinite(t.durationS) ? t.durationS : 0) };
}

export interface SyncInput {
  timing: ClipTiming;
  nowMs: number;
  /** Workspace `playing`. */
  playing: boolean;
  /** This clip is the workspace `activeClip` (clock master while playing). */
  master: boolean;
  videoTimeS: number;
  videoPaused: boolean;
  /** Last clock value this clip wrote, or null when it has not been driving. */
  lastWrittenMs: number | null;
}

export type SyncAction =
  /** Master while playing: play the video; its frames write the clock. */
  | { kind: 'drive'; seekTo?: number }
  /** Not the master while playing: play along and seek only on real drift. */
  | { kind: 'follow'; seekTo?: number }
  /** Paused or scrubbing: keep the video paused on the clock frame. */
  | { kind: 'hold'; seekTo?: number }
  /** The master clip played past its end: stop the workspace. */
  | { kind: 'ended' }
  /** The clock is outside this clip. */
  | { kind: 'no-footage' };

/** Clock jumps larger than this while driving were made by someone else (scrub, seek). */
export const JUMP_TOLERANCE_MS = 60;
/** A following clip is re-seeked only past this drift. */
export const FOLLOW_DRIFT_S = 0.25;
const SAME_FRAME_S = 0.001;

export function syncDecision(i: SyncInput): SyncAction {
  const { timing, nowMs } = i;
  const dur = Number.isFinite(timing.durationS) ? timing.durationS : Infinity;
  const target = videoTimeForClock(timing, nowMs);
  const clamped = Math.min(Math.max(target, 0), dur);
  const inside = target >= 0 && target <= dur;
  const withSeek = <K extends 'drive' | 'follow' | 'hold'>(kind: K, tol: number) =>
    Math.abs(i.videoTimeS - clamped) > tol ? { kind, seekTo: clamped } : { kind };

  if (i.playing && i.master) {
    if (target > dur) return { kind: 'ended' };
    if (target < 0) return { kind: 'drive', seekTo: 0 };
    const jumped =
      i.lastWrittenMs === null || Math.abs(nowMs - i.lastWrittenMs) > JUMP_TOLERANCE_MS;
    return jumped ? withSeek('drive', SAME_FRAME_S) : { kind: 'drive' };
  }
  if (!inside) return { kind: 'no-footage' };
  if (i.playing) return withSeek('follow', FOLLOW_DRIFT_S);
  return withSeek('hold', SAME_FRAME_S);
}
