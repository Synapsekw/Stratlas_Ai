import { createWorkspace } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { advance, startPlaybackLoop } from './playback';

describe('advance', () => {
  it('moves the clock by elapsed time times rate', () => {
    expect(advance(1_000, 16, 2, undefined)).toEqual({ nowMs: 1_032, stop: false });
  });
  it('stops at the end of the active clip', () => {
    expect(advance(9_990, 16, 1, 10_000)).toEqual({ nowMs: 10_000, stop: true });
  });
  it('ignores huge frame gaps (a hidden window) by capping the step', () => {
    expect(advance(0, 5_000, 1, undefined).nowMs).toBe(250);
  });
});

describe('startPlaybackLoop', () => {
  it('advances nowMs while playing and stops when paused', () => {
    const ws = createWorkspace();
    ws.getState().setTime(1_000);
    const frames: ((t: number) => void)[] = [];
    const raf = (cb: (t: number) => void) => {
      frames.push(cb);
      return frames.length;
    };
    const stop = startPlaybackLoop(
      ws,
      () => undefined,
      raf,
      () => undefined,
    );
    ws.getState().setRate(2);
    ws.getState().play();
    frames.shift()?.(100); // first frame only sets the reference time
    frames.shift()?.(150);
    expect(ws.getState().nowMs).toBe(1_100);
    ws.getState().pause();
    frames.shift()?.(200);
    expect(ws.getState().nowMs).toBe(1_100);
    stop();
  });

  it('pauses at the clip end', () => {
    const ws = createWorkspace();
    ws.getState().setTime(990);
    const frames: ((t: number) => void)[] = [];
    const stop = startPlaybackLoop(
      ws,
      () => 1_000,
      (cb) => frames.push(cb),
      () => undefined,
    );
    ws.getState().play();
    frames.shift()?.(0);
    frames.shift()?.(50);
    expect(ws.getState().nowMs).toBe(1_000);
    expect(ws.getState().playing).toBe(false);
    stop();
  });
});
