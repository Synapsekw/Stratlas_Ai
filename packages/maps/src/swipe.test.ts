import { describe, expect, it } from 'vitest';
import { blendOpacity, clampSwipe, stepValue, swipeAt, swipeClip, SWIPE_MARGIN } from './swipe';

describe('swipe geometry', () => {
  it('turns the divider into the later pane clip, in whole pixels', () => {
    expect(swipeClip(0.5, 1000)).toEqual({ hiddenPx: 500, clipPath: 'inset(0px 0px 0px 500px)' });
    expect(swipeClip(0.3333, 901).hiddenPx).toBe(300);
  });

  it('keeps the divider inside the margins', () => {
    expect(clampSwipe(-1)).toBe(SWIPE_MARGIN);
    expect(clampSwipe(2)).toBe(1 - SWIPE_MARGIN);
    expect(clampSwipe(Number.NaN)).toBe(0.5);
    expect(swipeClip(0, 1000).hiddenPx).toBe(20);
  });

  it('follows the pointer across the box', () => {
    expect(swipeAt(350, { left: 100, width: 1000 })).toBeCloseTo(0.25);
    expect(swipeAt(50, { left: 100, width: 1000 })).toBe(SWIPE_MARGIN);
    expect(swipeAt(50, { left: 0, width: 0 })).toBe(0.5);
  });
});

describe('blend', () => {
  it('maps the slider to the later pane opacity', () => {
    expect(blendOpacity(0.5)).toBe(0.5);
    expect(blendOpacity(0)).toBe(0);
    expect(blendOpacity(1.4)).toBe(1);
    expect(blendOpacity(0.333)).toBe(0.33);
    expect(blendOpacity(Number.NaN)).toBe(0.5);
  });
});

describe('keyboard steps', () => {
  it('moves by 2%, 10% with Shift, and to the ends', () => {
    expect(stepValue(0.5, 'ArrowRight', false)).toBeCloseTo(0.52);
    expect(stepValue(0.5, 'ArrowLeft', true)).toBeCloseTo(0.4);
    expect(stepValue(0.99, 'ArrowUp', true)).toBe(1);
    expect(stepValue(0.5, 'Home', false)).toBe(0);
    expect(stepValue(0.5, 'End', false)).toBe(1);
    expect(stepValue(0.5, 'a', false)).toBeNull();
  });
});
