import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearWalkPlayback,
  setWalkPlayback,
  walkPlayback,
  watchWalkPlayback,
  type WalkPlaybackState,
} from './walkPlayback';

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
