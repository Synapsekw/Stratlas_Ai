import { describe, expect, it } from 'vitest';
import type { LensModel, Vec3 } from '@aio/schema';
import { imageToRay, lensAngles, pixelToRay, rayToImage, rayToPixel } from './lens';

const ftheta: LensModel = { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 };
const fthetaK: LensModel = { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9, k: [-0.05, 0.004] };
const pinhole: LensModel = { model: 'pinhole', hfovDeg: 83, aspect: 16 / 9 };
const deg = (r: number) => (r * 180) / Math.PI;
const angleFromAxis = (d: Vec3) => deg(Math.acos(-d[2] / Math.hypot(...d)));

describe('lensAngles', () => {
  it('gives the pinhole vertical fov from the aspect', () => {
    const a = lensAngles(pinhole);
    expect(deg(a.hfov)).toBeCloseTo(83, 9);
    expect(deg(a.vfov)).toBeCloseTo(
      deg(2 * Math.atan(Math.tan((83 * Math.PI) / 360) / (16 / 9))),
      9,
    );
  });
  it('is linear in angle for the equidistant f-theta lens', () => {
    expect(deg(lensAngles(ftheta).vfov)).toBeCloseTo(114 / (16 / 9), 9);
  });
});

describe('image <-> ray', () => {
  for (const lens of [ftheta, fthetaK, pinhole]) {
    const name = `${lens.model}${lens.model === 'ftheta' && lens.k ? '+k' : ''}`;
    it(`${name}: the image centre looks down -Z`, () => {
      const d = imageToRay(lens, 0.5, 0.5);
      expect(d[0]).toBeCloseTo(0, 12);
      expect(d[1]).toBeCloseTo(0, 12);
      expect(d[2]).toBeCloseTo(-1, 12);
    });
    it(`${name}: the right edge is at half the horizontal fov, image up is +Y`, () => {
      expect(angleFromAxis(imageToRay(lens, 1, 0.5))).toBeCloseTo(lens.hfovDeg / 2, 9);
      expect(imageToRay(lens, 1, 0.5)[0]).toBeGreaterThan(0);
      expect(imageToRay(lens, 0.5, 0)[1]).toBeGreaterThan(0);
    });
    it(`${name}: pixel -> ray -> pixel round trips over the frame`, () => {
      for (let i = 0; i <= 10; i++) {
        for (let j = 0; j <= 10; j++) {
          const [x, y] = [i / 10, j / 10];
          const back = rayToImage(lens, imageToRay(lens, x, y));
          expect(back).not.toBeNull();
          expect(back?.[0]).toBeCloseTo(x, 9);
          expect(back?.[1]).toBeCloseTo(y, 9);
        }
      }
    });
  }

  it('f-theta: the top edge is at hfov / aspect / 2 (equidistant)', () => {
    expect(angleFromAxis(imageToRay(ftheta, 0.5, 0))).toBeCloseTo(114 / (16 / 9) / 2, 9);
  });

  it('f-theta reaches past 90 degrees for a wide lens; pinhole rejects rays behind it', () => {
    const wide: LensModel = { model: 'ftheta', hfovDeg: 200, aspect: 1 };
    expect(angleFromAxis(imageToRay(wide, 1, 0.5))).toBeCloseTo(100, 9);
    expect(rayToImage(pinhole, [0, 0, 1])).toBeNull();
    expect(rayToImage(pinhole, [1, 0, 0])).toBeNull();
  });

  it('works in pixels with a top-left origin', () => {
    const d = pixelToRay(ftheta, 1280, 360, 1280, 720);
    expect(angleFromAxis(d)).toBeCloseTo(57, 9);
    const p = rayToPixel(ftheta, d, 1280, 720);
    expect(p?.[0]).toBeCloseTo(1280, 6);
    expect(p?.[1]).toBeCloseTo(360, 6);
  });

  it('matches the HCl artifact shader mapping', () => {
    // artifact: rho = theta / halfH; uv = (0.5 + 0.5 rho cos psi, 0.5 + 0.5 rho sin psi * aspect)
    const d: Vec3 = [0.3, 0.2, -0.8];
    const L = Math.hypot(...d);
    const th = Math.acos(-d[2] / L);
    const psi = Math.atan2(d[1], d[0]);
    const rho = th / ((57 * Math.PI) / 180);
    const u = 0.5 + 0.5 * rho * Math.cos(psi);
    const vUp = 0.5 + 0.5 * rho * Math.sin(psi) * (16 / 9);
    const img = rayToImage(ftheta, d);
    expect(img?.[0]).toBeCloseTo(u, 9);
    expect(img?.[1]).toBeCloseTo(1 - vUp, 9);
  });
});
