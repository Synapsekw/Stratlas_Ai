import { describe, expect, it } from 'vitest';
import { offscreenOrigin, windowMode, windowSize } from './windowMode';

describe('windowMode', () => {
  it('keeps a normal install on screen', () => {
    expect(windowMode({})).toBe('normal');
  });

  it('moves isolated test profiles off-screen', () => {
    expect(windowMode({ STRATLAS_USER_DATA: 'C:/tmp/x' })).toBe('offscreen');
  });

  it('lets a person watch a test with STRATLAS_WINDOW=visible', () => {
    expect(windowMode({ STRATLAS_USER_DATA: 'C:/tmp/x', STRATLAS_WINDOW: 'visible' })).toBe(
      'normal',
    );
  });

  it('forces off-screen on request', () => {
    expect(windowMode({ STRATLAS_WINDOW: 'offscreen' })).toBe('offscreen');
  });
});

describe('offscreenOrigin', () => {
  it('places the window left of every display, including a monitor left of the primary', () => {
    const displays = [
      { x: 0, y: 0, width: 2560, height: 1440 },
      { x: -1920, y: 200, width: 1920, height: 1080 },
    ];
    const o = offscreenOrigin(displays, 1440);
    expect(o.x + 1440).toBeLessThan(-1920);
    expect(o.y).toBe(0);
  });
});

describe('windowSize', () => {
  it('is 1440 x 900 unless set, and never under the 1100 x 700 minimum', () => {
    expect(windowSize({})).toEqual({ width: 1440, height: 900 });
    expect(windowSize({ STRATLAS_WINDOW_SIZE: '1100x700' })).toEqual({ width: 1100, height: 700 });
    expect(windowSize({ STRATLAS_WINDOW_SIZE: '800x600' })).toEqual({ width: 1100, height: 700 });
    expect(windowSize({ STRATLAS_WINDOW_SIZE: 'big' })).toEqual({ width: 1440, height: 900 });
  });
});
