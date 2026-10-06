import { describe, expect, it } from 'vitest';
import { canSwipe, useCompareView } from './MapSwipe';
import type { SplitModel } from './SplitPanes';

const split = (sides: SplitModel['sides'], dates = true): SplitModel => ({
  options: ['3d', 'map', 'raster'],
  sides,
  reports: [],
  set: () => undefined,
  index: null,
  ...(dates ? { dates: { captures: ['jan', 'jun'] } } : {}),
});

describe('swipe and blend', () => {
  it('apply to two maps or two orthos of two dates only', () => {
    const two = { leftCapture: 'jan', rightCapture: 'jun' };
    expect(canSwipe(split({ left: 'map', right: 'map', ...two }))).toBe(true);
    expect(canSwipe(split({ left: 'raster', right: 'raster', ...two }))).toBe(true);
    expect(canSwipe(split({ left: '3d', right: '3d', ...two }))).toBe(false);
    expect(canSwipe(split({ left: '3d', right: 'map', ...two }))).toBe(false);
    expect(canSwipe(split({ left: 'map', right: 'map', ...two }, false))).toBe(false);
    expect(
      canSwipe(split({ left: 'map', right: 'map', leftCapture: 'jan', rightCapture: 'jan' })),
    ).toBe(false);
  });

  it('keeps the divider and the blend in range', () => {
    const s = useCompareView.getState();
    s.set({ view: 'swipe', at: 1.5 });
    expect(useCompareView.getState()).toMatchObject({ view: 'swipe', at: 0.98, blend: 0.5 });
    s.set({ blend: -1 });
    expect(useCompareView.getState()).toMatchObject({ view: 'swipe', at: 0.98, blend: 0 });
    s.set({ view: 'side', at: 0.5, blend: 0.5 });
  });
});
