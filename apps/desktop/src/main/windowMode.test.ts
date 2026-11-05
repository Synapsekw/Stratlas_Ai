import { describe, expect, it } from 'vitest';
import { offscreenOrigin, outerSizeFor, windowMode, windowSize } from './windowMode';

describe('windowMode', () => {
  it('keeps a normal install on screen', () => {
    expect(windowMode({})).toBe('normal');
  });

  it('moves isolated test profiles off-screen', () => {
    expect(windowMode({ QUADRION_USER_DATA: 'C:/tmp/x' })).toBe('offscreen');
  });

  it('lets a person watch a test with QUADRION_WINDOW=visible', () => {
    expect(windowMode({ QUADRION_USER_DATA: 'C:/tmp/x', QUADRION_WINDOW: 'visible' })).toBe(
      'normal',
    );
  });

  it('forces off-screen on request', () => {
    expect(windowMode({ QUADRION_WINDOW: 'offscreen' })).toBe('offscreen');
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
    expect(windowSize({})).toEqual({ width: 1440, height: 900, asked: false });
    expect(windowSize({ QUADRION_WINDOW_SIZE: '1100x700' })).toEqual({
      width: 1100,
      height: 700,
      asked: true,
    });
    expect(windowSize({ QUADRION_WINDOW_SIZE: '800x600' })).toEqual({
      width: 1100,
      height: 700,
      asked: true,
    });
    expect(windowSize({ QUADRION_WINDOW_SIZE: 'big' })).toEqual({
      width: 1440,
      height: 900,
      asked: false,
    });
  });
});

describe('outerSizeFor', () => {
  const asked = { width: 1366, height: 768 };

  it('leaves a window whose page is the size asked for alone', () => {
    expect(outerSizeFor(asked, [1366, 768], [1366, 768])).toBeNull();
  });

  it('grows a window that the screen cut down at creation (CI: 1366 asked, 1100 given)', () => {
    expect(outerSizeFor(asked, [1100, 720], [1100, 720])).toEqual([1366, 768]);
  });

  it('takes off the borders a window wider than its screen adds to the page', () => {
    // measured: grown past the screen, the page is 16 x 8 px larger than the window's bounds
    expect(outerSizeFor(asked, [1382, 776], [1366, 768])).toEqual([1350, 760]);
  });
});
