import { projectToLocal } from '@aio/geo';
import type { Vec3 } from '@aio/schema';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { angledCamera, frameFor, pixelOf, topDownCamera, yardExtent } from './framing';

const ORIGIN: Vec3 = [500_000, 2_000_000, 40];

describe('frameFor', () => {
  it('gives the metres per pixel and a pixel size whose longest side is the budget', () => {
    const f = frameFor([1000, 2000, 1400, 2100], 2000);
    expect(f.mPerPx).toBeCloseTo(0.2, 9);
    expect(f.widthPx).toBe(2000);
    expect(f.heightPx).toBe(500);
    expect(f.extent).toEqual([1000, 2000, 1400, 2100]);
  });

  it('grows the extent about its centre so whole pixels cover it exactly', () => {
    const f = frameFor([0, 0, 100, 33.3], 1000);
    expect(f.widthPx).toBe(1000);
    expect(f.heightPx).toBe(333);
    const [e0, n0, e1, n1] = f.extent;
    expect((e1 - e0) / f.mPerPx).toBeCloseTo(f.widthPx, 6);
    expect((n1 - n0) / f.mPerPx).toBeCloseTo(f.heightPx, 6);
    expect((n0 + n1) / 2).toBeCloseTo(16.65, 6);
    expect(n0).toBeLessThanOrEqual(0);
    expect(n1).toBeGreaterThanOrEqual(33.3);
  });

  it('maps west-north to the top left and back within half a pixel', () => {
    const f = frameFor([1000, 2000, 1400, 2300], 1600);
    expect(f.toPx([1000, 2300])).toEqual([0, 0]);
    const [x, y] = f.toPx([1400, 2000]);
    expect(x).toBeCloseTo(f.widthPx, 6);
    expect(y).toBeCloseTo(f.heightPx, 6);
    for (const p of [
      [1123.4, 2111.1],
      [1399.9, 2000.2],
      [1000.01, 2299.7],
    ] as const) {
      const px = f.toPx(p).map(Math.round) as [number, number];
      const back = f.toSite(px);
      expect(Math.abs(back[0] - p[0])).toBeLessThanOrEqual(f.mPerPx / 2 + 1e-9);
      expect(Math.abs(back[1] - p[1])).toBeLessThanOrEqual(f.mPerPx / 2 + 1e-9);
    }
  });
});

describe('yardExtent', () => {
  it('is the piles extent with a margin of a tenth, at least 10 m', () => {
    const rings = [
      [
        [100, 100],
        [200, 100],
        [200, 150],
      ],
      [
        [300, 120],
        [310, 130],
        [305, 140],
      ],
    ] as const;
    expect(yardExtent(rings)).toEqual([79, 79, 331, 171]);
    expect(
      yardExtent([
        [
          [0, 0],
          [20, 0],
          [20, 20],
        ],
      ]),
    ).toEqual([-10, -10, 30, 30]);
  });

  it('is null without a pile', () => {
    expect(yardExtent([])).toBeNull();
    expect(yardExtent([[]])).toBeNull();
  });
});

describe('topDownCamera', () => {
  const f = frameFor([1000, 2000, 1400, 2100], 2000);
  const cam = topDownCamera(f, ORIGIN, [30, 60]);
  const ndc = (e: number, n: number, h = 45) => {
    const [x, y, z] = projectToLocal([e, n, h], ORIGIN);
    return new Vector3(x, y, z).project(cam);
  };

  it('looks straight down, north up', () => {
    const dir = cam.getWorldDirection(new Vector3());
    expect(dir.x).toBeCloseTo(0, 9);
    expect(dir.y).toBeCloseTo(-1, 9);
    expect(dir.z).toBeCloseTo(0, 9);
    const north = ndc(1200, 2090);
    const south = ndc(1200, 2010);
    expect(north.y).toBeGreaterThan(south.y);
    expect(ndc(1390, 2050).x).toBeGreaterThan(ndc(1010, 2050).x);
  });

  it('has the extent exactly in view, at any height of the piles', () => {
    for (const h of [30, 45, 60]) {
      const nw = ndc(1000, 2100, h);
      const se = ndc(1400, 2000, h);
      expect(nw.x).toBeCloseTo(-1, 9);
      expect(nw.y).toBeCloseTo(1, 9);
      expect(se.x).toBeCloseTo(1, 9);
      expect(se.y).toBeCloseTo(-1, 9);
      expect(Math.abs(nw.z)).toBeLessThan(1);
    }
  });

  it('puts a site point on the pixel the frame says', () => {
    const local = projectToLocal([1234, 2077, 50], ORIGIN);
    const px = pixelOf(cam, local, f.widthPx, f.heightPx);
    const want = f.toPx([1234, 2077]);
    expect(px?.[0]).toBeCloseTo(want[0], 6);
    expect(px?.[1]).toBeCloseTo(want[1], 6);
  });
});

describe('angledCamera', () => {
  const extent = [1000, 2000, 1400, 2300] as const;
  const cam = angledCamera(extent, ORIGIN, [30, 60], 1.5);

  it('looks from the south-east, down at 35 degrees', () => {
    const dir = cam.getWorldDirection(new Vector3());
    // from the south-east: looking north-west, i.e. -x (west) and -z (north)
    expect(dir.x).toBeLessThan(0);
    expect(dir.z).toBeLessThan(0);
    expect(dir.x).toBeCloseTo(dir.z, 6);
    expect((Math.asin(-dir.y) * 180) / Math.PI).toBeCloseTo(35, 6);
    expect(cam.aspect).toBe(1.5);
  });

  it('frames the whole yard', () => {
    for (const [e, n] of [
      [1000, 2000],
      [1400, 2000],
      [1000, 2300],
      [1400, 2300],
    ] as const) {
      for (const h of [30, 60]) {
        const px = pixelOf(cam, projectToLocal([e, n, h], ORIGIN), 1500, 1000);
        expect(px).not.toBeNull();
        if (!px) continue;
        expect(px[0]).toBeGreaterThanOrEqual(0);
        expect(px[0]).toBeLessThanOrEqual(1500);
        expect(px[1]).toBeGreaterThanOrEqual(0);
        expect(px[1]).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('gives no pixel for a point behind the camera', () => {
    const behind = cam.position
      .clone()
      .sub(cam.getWorldDirection(new Vector3()).multiplyScalar(10));
    expect(pixelOf(cam, [behind.x, behind.y, behind.z], 1500, 1000)).toBeNull();
  });
});
