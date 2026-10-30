import { describe, expect, it } from 'vitest';
import { FIT_MAX_ZOOM, fitFor } from './fitView';

/** The width in pixels a span of longitude takes at a zoom (512 px tiles). */
const spanPx = (deg: number, zoom: number) => (deg / 360) * 512 * 2 ** zoom;

describe('framing the project on the map', () => {
  it('pads by 8 %', () => {
    // a wide, low site: its width decides the zoom
    const cam = fitFor([[48.0, 29.0, 48.02, 29.001]], { width: 1000, height: 800 });
    expect(cam).not.toBeNull();
    if (!cam) return;
    expect(spanPx(0.02, cam.zoom)).toBeCloseTo(1000 * 0.84, 3);
    expect(cam.center[0]).toBeCloseTo(48.01, 9);
    expect(cam.center[1]).toBeCloseTo(29.0005, 4);
  });

  it('frames the union of every extent', () => {
    const one = fitFor([[48.0, 29.0, 48.01, 29.001]], { width: 1000, height: 800 });
    const both = fitFor(
      [
        [48.0, 29.0, 48.01, 29.001],
        [48.01, 29.0, 48.02, 29.001],
      ],
      { width: 1000, height: 800 },
    );
    expect(both?.center[0]).toBeCloseTo(48.01, 9);
    expect((one?.zoom ?? 0) - (both?.zoom ?? 0)).toBeCloseTo(1, 6);
  });

  it('opens a small site close enough to see issue shapes, never closer than z19', () => {
    expect(fitFor([[48, 29, 48, 29]], { width: 800, height: 600 })?.zoom).toBe(FIT_MAX_ZOOM);
    const tiny = fitFor([[48, 29, 48.0004, 29.0003]], { width: 800, height: 600 });
    expect(tiny?.zoom).toBe(19);
  });

  it('fits a north-south corridor by its height, north up', () => {
    const cam = fitFor([[48.0, 29.0, 48.001, 29.05]], { width: 1000, height: 600 });
    expect(cam).not.toBeNull();
    if (!cam) return;
    // the corridor's length fills 84 % of the height; its width is far inside
    expect(spanPx(0.001, cam.zoom)).toBeLessThan(1000 * 0.84);
    expect(cam.zoom).toBeLessThan(FIT_MAX_ZOOM);
  });

  it('frames nothing without an extent', () => {
    expect(fitFor([], { width: 800, height: 600 })).toBeNull();
  });
});
