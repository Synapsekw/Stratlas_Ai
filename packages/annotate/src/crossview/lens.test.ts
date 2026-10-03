import type { LensModel, Quat } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { cameraToPixel, pixelToCameraRay, pixelToWorldRay, worldToPixel } from './lens';

const pinhole: LensModel = { model: 'pinhole', hfovDeg: 90, aspect: 16 / 9 };
const ftheta: LensModel = { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 };
const size: [number, number] = [1280, 720];

const close = (a: readonly number[], b: readonly number[], eps = 1e-6) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => {
    expect(v).toBeCloseTo(b[i] ?? NaN, -Math.log10(eps));
  });
};

describe('pixelToCameraRay', () => {
  it('looks down -Z at the image centre', () => {
    close(pixelToCameraRay(pinhole, [640, 360], size), [0, 0, -1]);
    close(pixelToCameraRay(ftheta, [640, 360], size), [0, 0, -1]);
  });

  it('pinhole: the right edge is half the horizontal FOV away', () => {
    const d = pixelToCameraRay(pinhole, [1280, 360], size);
    close(d, [Math.SQRT1_2, 0, -Math.SQRT1_2]);
  });

  it('image up is camera +Y', () => {
    const d = pixelToCameraRay(pinhole, [640, 0], size);
    expect(d[1]).toBeGreaterThan(0);
  });

  it('f-theta: angle grows linearly with radius (57 deg at the right edge)', () => {
    const d = pixelToCameraRay(ftheta, [1280, 360], size);
    const angle = (Math.acos(-d[2]) * 180) / Math.PI;
    expect(angle).toBeCloseTo(57, 6);
    const q = pixelToCameraRay(ftheta, [960, 360], size);
    expect((Math.acos(-q[2]) * 180) / Math.PI).toBeCloseTo(28.5, 6);
  });

  it('round-trips through cameraToPixel', () => {
    for (const lens of [pinhole, ftheta]) {
      const px: [number, number] = [200, 600];
      const d = pixelToCameraRay(lens, px, size);
      const back = cameraToPixel(lens, d, size);
      expect(back).not.toBeNull();
      if (back) close(back, px, 1e-4);
    }
  });

  it('points behind a pinhole camera have no pixel', () => {
    expect(cameraToPixel(pinhole, [0, 0, 1], size)).toBeNull();
  });
});

describe('world rays', () => {
  // Camera turned to look straight down: rotate -90 deg about X.
  const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const pose = { pos: [0, 10, 0] as [number, number, number], q: down };

  it('rotates the ray by the pose', () => {
    const r = pixelToWorldRay(pose, pinhole, [640, 360], size);
    close(r.origin, [0, 10, 0]);
    close(r.dir, [0, -1, 0]);
  });

  it('projects a world point back into the image', () => {
    const px = worldToPixel(pose, pinhole, [0, 0, 0], size);
    expect(px).not.toBeNull();
    if (px) close(px, [640, 360], 1e-4);
  });

  it('returns null for a point outside the image', () => {
    expect(worldToPixel(pose, pinhole, [100, 0, 0], size)).toBeNull();
  });
});
