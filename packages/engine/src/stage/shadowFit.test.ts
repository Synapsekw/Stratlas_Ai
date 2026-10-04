import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fitShadow, lightBasis } from './shadowFit';

// a plant about 2 km by 1 km and 80 m tall, with ground down to the sea
const PLANT = new Box3(new Vector3(-1000, -7, -500), new Vector3(1000, 80, 500));
const R = PLANT.getSize(new Vector3()).length() / 2;
const SUN = new Vector3(-0.4, 0.75, 0.5).normalize();

/** Light-space coordinates of a point for a fit. */
function lightCoords(fit: ReturnType<typeof fitShadow>, p: Vector3) {
  const s = fit.position.clone().sub(fit.target).normalize();
  const { x, y } = lightBasis(s);
  const d = p.clone().sub(fit.position);
  return { a: d.dot(x), b: d.dot(y), depth: -d.dot(s) };
}

describe('fitShadow', () => {
  it('covers the orbit target and the content depth', () => {
    const target = new Vector3(300, 10, -100);
    const fit = fitShadow(SUN, PLANT, R, target, 200, 4096);
    const c = lightCoords(fit, target);
    expect(Math.abs(c.a)).toBeLessThanOrEqual(fit.halfExtent);
    expect(Math.abs(c.b)).toBeLessThanOrEqual(fit.halfExtent);
    for (let i = 0; i < 8; i++) {
      const p = new Vector3(
        i & 1 ? PLANT.max.x : PLANT.min.x,
        i & 2 ? PLANT.max.y : PLANT.min.y,
        i & 4 ? PLANT.max.z : PLANT.min.z,
      );
      const d = lightCoords(fit, p).depth;
      expect(d).toBeGreaterThan(fit.near);
      expect(d).toBeLessThan(fit.far);
    }
  });

  it('is crisp close up and never wider than the content far out', () => {
    const near = fitShadow(SUN, PLANT, R, new Vector3(), 50, 4096);
    const far = fitShadow(SUN, PLANT, R, new Vector3(), 20000, 4096);
    expect(near.texel).toBeLessThan(0.05);
    expect(far.halfExtent).toBeLessThanOrEqual(R * 1.1);
    // the whole footprint fits in the far map
    for (const x of [-1000, 1000])
      for (const z of [-500, 500]) {
        const c = lightCoords(far, new Vector3(x, 0, z));
        expect(Math.abs(c.a)).toBeLessThanOrEqual(far.halfExtent + 1e-6);
        expect(Math.abs(c.b)).toBeLessThanOrEqual(far.halfExtent + 1e-6);
      }
  });

  it('snaps to whole texels so small target moves do not swim', () => {
    const a = fitShadow(SUN, PLANT, R, new Vector3(100, 0, 100), 300, 4096);
    const b = fitShadow(SUN, PLANT, R, new Vector3(100 + a.texel * 0.3, 0, 100), 300, 4096);
    expect(b.position.distanceTo(a.position)).toBeLessThan(1e-6);
    const { x } = lightBasis(SUN);
    const k = a.position.dot(x) / a.texel;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
  });

  it('keeps the square over the content when the target is outside it', () => {
    const fit = fitShadow(SUN, PLANT, R, new Vector3(5000, 0, 0), 300, 4096);
    const c = lightCoords(fit, new Vector3(1000, 0, 0));
    expect(Math.abs(c.a)).toBeLessThan(fit.halfExtent * 3);
  });

  it('handles a sun straight overhead', () => {
    const fit = fitShadow(new Vector3(0, 1, 0), PLANT, R, new Vector3(), 300, 2048);
    expect(Number.isFinite(fit.position.x)).toBe(true);
    expect(fit.far).toBeGreaterThan(87);
  });
});
