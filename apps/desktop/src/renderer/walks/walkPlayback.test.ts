import { afterEach, describe, expect, it } from 'vitest';
import { clearWalkPlayback, setWalkPlayback, walkPlayback } from './walkPlayback';

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
