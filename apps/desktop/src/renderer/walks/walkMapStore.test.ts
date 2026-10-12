import { afterEach, describe, expect, it, vi } from 'vitest';
import { setWalkMapOverlays, setWalkMapPick, walkMap } from './walkMapStore';

afterEach(() => {
  setWalkMapPick(null);
  setWalkMapOverlays([]);
});

describe('walkMap', () => {
  it('keeps one empty list so the map does not redraw for nothing', () => {
    const before = walkMap.getState().overlays;
    setWalkMapOverlays([]);
    expect(walkMap.getState().overlays).toBe(before);
    setWalkMapOverlays([
      { id: 'walk-walk-a', data: { type: 'FeatureCollection', features: [] }, layers: [] },
    ]);
    expect(walkMap.getState().overlays).toHaveLength(1);
  });

  it('a pick clears itself once it reports or is cancelled', () => {
    const onPick = vi.fn();
    const onCancel = vi.fn();
    setWalkMapPick({ onPick, onCancel });
    walkMap.getState().pick?.onPick([1, 0, 2]);
    expect(onPick).toHaveBeenCalledWith([1, 0, 2]);
    expect(walkMap.getState().pick).toBeNull();

    setWalkMapPick({ onPick, onCancel });
    walkMap.getState().pick?.onCancel?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(walkMap.getState().pick).toBeNull();
  });
});
