import { describe, expect, it } from 'vitest';
import { wholeEarthDistance } from './camera';
import { WHOLE_EARTH_HEIGHT_M } from './look';

const R = 6378137;
const RAD = Math.PI / 180;

/** The radius the Earth's disc is drawn at, as a tangent of the view angle from the middle. */
const discTan = (distance: number) => Math.tan(Math.asin(R / distance));

describe('wholeEarthDistance', () => {
  it('fits the disc into a wide view by its height, with the margin left over', () => {
    const d = wholeEarthDistance({ width: 1100, height: 720 });
    // CesiumJS's fov runs along the longer side
    const tanY = (Math.tan(30 * RAD) * 720) / 1100;
    const share = discTan(d) / tanY;
    expect(share).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(share).toBeGreaterThan(0.85);
  });

  it('fits a tall view by its width', () => {
    const d = wholeEarthDistance({ width: 600, height: 1000 });
    const tanX = (Math.tan(30 * RAD) * 600) / 1000;
    const share = discTan(d) / tanX;
    expect(share).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(share).toBeGreaterThan(0.85);
  });

  it('stands above the height from which the whole Earth counts as in view', () => {
    expect(wholeEarthDistance({ width: 1100, height: 720 })).toBeGreaterThan(
      WHOLE_EARTH_HEIGHT_M + R,
    );
    expect(wholeEarthDistance({ width: 1920, height: 1080 })).toBeGreaterThan(
      WHOLE_EARTH_HEIGHT_M + R,
    );
  });

  it('takes the view angle and margin it is given', () => {
    const narrow = wholeEarthDistance({ width: 1000, height: 1000 }, 40, 0.2);
    expect(discTan(narrow) / Math.tan(20 * RAD)).toBeCloseTo(0.8, 9);
  });
});
