import { afterEach, describe, expect, it } from 'vitest';
import { setWalkMapOverlays, setWalkMapPointer, walkMap } from './walkMapStore';

afterEach(() => {
  setWalkMapPointer(null);
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

  it('the pointer session is replaced and cleared', () => {
    const a = { onClick: () => undefined };
    const b = { onMove: () => undefined };
    setWalkMapPointer(a);
    expect(walkMap.getState().pointer).toBe(a);
    setWalkMapPointer(b);
    expect(walkMap.getState().pointer).toBe(b);
    setWalkMapPointer(null);
    expect(walkMap.getState().pointer).toBeNull();
  });
});
