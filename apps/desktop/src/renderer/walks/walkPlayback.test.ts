import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearWalkPlayback,
  publishWalkPlayback,
  setWalkPlayback,
  walkPlayback,
  watchWalkPlayback,
  type WalkPlaybackState,
} from './walkPlayback';

/** A stand-in for the pane's video element: fires its listeners on demand. */
function fakeVideo(currentTime = 0) {
  const target = new EventTarget();
  return {
    currentTime,
    addEventListener: (type: string, fn: () => void) => {
      target.addEventListener(type, fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      target.removeEventListener(type, fn);
    },
    fire(type: string) {
      target.dispatchEvent(new Event(type));
    },
  };
}

afterEach(() => {
  walkPlayback.setState({ layerId: null, t: null });
});

describe('walkPlayback', () => {
  it('holds the walk the 360 pane plays and its time', () => {
    expect(walkPlayback.getState()).toEqual({ layerId: null, t: null });
    setWalkPlayback('walk-a', 12.5);
    expect(walkPlayback.getState()).toEqual({ layerId: 'walk-a', t: 12.5 });
    setWalkPlayback('walk-b', 3);
    expect(walkPlayback.getState()).toEqual({ layerId: 'walk-b', t: 3 });
  });

  it('does not write the same time twice', () => {
    setWalkPlayback('walk-a', 4);
    const before = walkPlayback.getState();
    setWalkPlayback('walk-a', 4);
    expect(walkPlayback.getState()).toBe(before);
  });

  it('a closing pane clears only its own walk', () => {
    setWalkPlayback('walk-b', 3);
    clearWalkPlayback('walk-a');
    expect(walkPlayback.getState().layerId).toBe('walk-b');
    clearWalkPlayback('walk-b');
    expect(walkPlayback.getState()).toEqual({ layerId: null, t: null });
  });
});

describe('publishWalkPlayback', () => {
  it('writes the time as soon as the video has loaded, before it plays', () => {
    const v = fakeVideo(0);
    publishWalkPlayback(v, 'walk-a');
    expect(walkPlayback.getState().layerId).toBeNull();
    v.fire('loadeddata');
    expect(walkPlayback.getState()).toEqual({ layerId: 'walk-a', t: 0 });
    v.currentTime = 7;
    v.fire('timeupdate');
    expect(walkPlayback.getState()).toEqual({ layerId: 'walk-a', t: 7 });
    v.currentTime = 2;
    v.fire('seeked');
    expect(walkPlayback.getState().t).toBe(2);
  });

  it('clears when the pane closes, and stops listening', () => {
    const v = fakeVideo(3);
    const stop = publishWalkPlayback(v, 'walk-a');
    v.fire('timeupdate');
    stop();
    expect(walkPlayback.getState()).toEqual({ layerId: null, t: null });
    v.fire('timeupdate');
    expect(walkPlayback.getState()).toEqual({ layerId: null, t: null });
  });

  it('a walk switch hands over to the new walk', () => {
    const a = fakeVideo(4);
    const stopA = publishWalkPlayback(a, 'walk-a');
    a.fire('loadeddata');
    stopA();
    const b = fakeVideo(0);
    publishWalkPlayback(b, 'walk-b');
    expect(walkPlayback.getState()).toEqual({ layerId: null, t: null });
    b.fire('loadeddata');
    expect(walkPlayback.getState()).toEqual({ layerId: 'walk-b', t: 0 });
  });
});

describe('watchWalkPlayback', () => {
  it('draws only for the walks it shows, and once more when the walk stops', () => {
    const draw = vi.fn<(p: WalkPlaybackState) => void>();
    const stop = watchWalkPlayback((id) => id === 'walk-a', draw);
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw).toHaveBeenLastCalledWith({ layerId: null, t: null });
    // another walk's ticks draw nothing
    setWalkPlayback('walk-z', 1);
    setWalkPlayback('walk-z', 2);
    expect(draw).toHaveBeenCalledTimes(1);
    setWalkPlayback('walk-a', 1);
    setWalkPlayback('walk-a', 2);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(draw).toHaveBeenLastCalledWith({ layerId: 'walk-a', t: 2 });
    clearWalkPlayback('walk-a');
    expect(draw).toHaveBeenCalledTimes(4);
    expect(draw).toHaveBeenLastCalledWith({ layerId: null, t: null });
    stop();
    setWalkPlayback('walk-a', 5);
    expect(draw).toHaveBeenCalledTimes(4);
  });
});
