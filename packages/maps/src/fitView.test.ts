import { describe, expect, it } from 'vitest';
import { FIT_MAX_ZOOM, FIT_MIN_SPAN_M, fitFor } from './fitView';

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

  it('keeps a narrow pane wide enough to show the ground around a small site', () => {
    // the Split map is some 244 px wide: z19 would show only about 30 m of ground across it
    const view = { width: 244, height: 560 };
    const cam = fitFor([[48, 29, 48.0001, 29.0001]], view);
    expect(cam).not.toBeNull();
    if (!cam) return;
    expect(cam.zoom).toBeLessThan(FIT_MAX_ZOOM);
    const mPerPx = (40_075_016.686 * Math.cos((29 * Math.PI) / 180)) / (512 * 2 ** cam.zoom);
    expect(244 * mPerPx).toBeCloseTo(FIT_MIN_SPAN_M, 3);
  });

  it('keeps a 360 pinned beside the site inside the padded frame of a narrow pane', () => {
    // the site, and a 360 pinned some 28 m east of it
    const site: [number, number, number, number] = [48, 29, 48.0002, 29.0002];
    const pano: [number, number, number, number] = [48.0005, 29.0001, 48.0005, 29.0001];
    const view = { width: 244, height: 560 };
    const cam = fitFor([site, pano], view);
    expect(cam).not.toBeNull();
    if (!cam) return;
    const x = (lon: number) => view.width / 2 + ((lon - cam.center[0]) / 360) * 512 * 2 ** cam.zoom;
    // both ends sit inside the 8 % margin, clear of the pane's edges
    expect(x(48)).toBeGreaterThanOrEqual(244 * 0.08 - 1e-6);
    expect(x(48.0005)).toBeLessThanOrEqual(244 * 0.92 + 1e-6);
  });

  it('still frames a site closer than the old z17 cap', () => {
    // a site some 150 m wide in a 1000 px map: the old fit stopped at z17
    const cam = fitFor([[48.0, 29.0, 48.0015, 29.0005]], { width: 1000, height: 800 });
    expect(cam?.zoom ?? 0).toBeGreaterThan(18);
    expect(cam?.zoom ?? 99).toBeLessThan(FIT_MAX_ZOOM);
  });

  it('frames nothing without an extent', () => {
    expect(fitFor([], { width: 800, height: 600 })).toBeNull();
  });
});
