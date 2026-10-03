import { describe, expect, it } from 'vitest';
import {
  clipWindow,
  clockForVideoTime,
  syncDecision,
  videoTimeForClock,
  type ClipTiming,
  type SyncInput,
} from './clock';

const timing: ClipTiming = { startUtcMs: 1_000_000, offsetMs: 2_000, durationS: 11 };

describe('time mapping (data-conventions section 3)', () => {
  it('maps video time to project time with the layer offset', () => {
    expect(clockForVideoTime(timing, 0)).toBe(1_002_000);
    expect(clockForVideoTime(timing, 1.5)).toBe(1_003_500);
    expect(videoTimeForClock(timing, 1_003_500)).toBe(1.5);
  });
  it('gives the clip window in project time', () => {
    expect(clipWindow(timing)).toEqual({ startMs: 1_002_000, endMs: 1_013_000 });
  });
});

const base: SyncInput = {
  timing,
  nowMs: 1_005_000,
  playing: false,
  master: true,
  videoTimeS: 3,
  videoPaused: true,
  lastWrittenMs: null,
};

describe('syncDecision', () => {
  it('holds a paused video still when it already shows the clock time', () => {
    expect(syncDecision(base)).toEqual({ kind: 'hold' });
  });

  it('seeks a paused video to the clock (scrubbing)', () => {
    expect(syncDecision({ ...base, nowMs: 1_007_250 })).toEqual({ kind: 'hold', seekTo: 5.25 });
  });

  it('lets the master clip drive the clock while playing', () => {
    expect(
      syncDecision({ ...base, playing: true, videoPaused: false, lastWrittenMs: 1_005_000 }),
    ).toEqual({
      kind: 'drive',
    });
  });

  it('starts the master video from the clock time when play is pressed', () => {
    expect(syncDecision({ ...base, playing: true, nowMs: 1_006_000, lastWrittenMs: null })).toEqual(
      {
        kind: 'drive',
        seekTo: 4,
      },
    );
  });

  it('follows a jump of the clock made by someone else while playing', () => {
    expect(
      syncDecision({
        ...base,
        playing: true,
        videoPaused: false,
        nowMs: 1_010_000,
        lastWrittenMs: 1_005_000,
      }),
    ).toEqual({ kind: 'drive', seekTo: 8 });
  });

  it('snaps the master to its first frame when play starts before the clip', () => {
    expect(syncDecision({ ...base, playing: true, nowMs: 900_000 })).toEqual({
      kind: 'drive',
      seekTo: 0,
    });
  });

  it('ends playback when the master clip runs past its end', () => {
    expect(syncDecision({ ...base, playing: true, nowMs: 1_014_000, videoPaused: false })).toEqual({
      kind: 'ended',
    });
  });

  it('reports no footage outside the clip when it is not driving', () => {
    expect(syncDecision({ ...base, nowMs: 900_000 })).toEqual({ kind: 'no-footage' });
    expect(syncDecision({ ...base, master: false, playing: true, nowMs: 1_020_000 })).toEqual({
      kind: 'no-footage',
    });
  });

  it('a slave clip plays along and corrects only real drift', () => {
    const slave = { ...base, master: false, playing: true, videoPaused: false };
    expect(syncDecision({ ...slave, videoTimeS: 3.1 })).toEqual({ kind: 'follow' });
    expect(syncDecision({ ...slave, videoTimeS: 2 })).toEqual({ kind: 'follow', seekTo: 3 });
  });

  it('clamps seeks to the clip', () => {
    expect(syncDecision({ ...base, nowMs: 1_013_000, videoTimeS: 0 })).toEqual({
      kind: 'hold',
      seekTo: 11,
    });
  });
});
