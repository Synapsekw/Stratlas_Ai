import type { Quat, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { photoFrustum, type Plane4 } from './frustum';

const down: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
const inside = (planes: Plane4[], p: Vec3) =>
  planes.every(([nx, ny, nz, d]) => nx * p[0] + ny * p[1] + nz * p[2] + d >= -1e-9);

describe('photoFrustum', () => {
  it('holds what a photo looking straight down sees, and its pixel scale', () => {
    const f = photoFrustum(
      { pos: [3, 10, 4], q: down },
      { model: 'pinhole', hfovDeg: 90, aspect: 4 / 3 },
      [1200, 900],
    );
    expect(f.planes).toHaveLength(6);
    expect(f.eye).toEqual([3, 10, 4]);
    expect(f.pxPerM).toBeCloseTo(600, 6);
    expect(inside(f.planes, [3, 0, 4])).toBe(true);
    expect(inside(f.planes, [12, 0, 4])).toBe(true); // 9 m aside at 10 m: inside 45 degrees
    expect(inside(f.planes, [30, 0, 4])).toBe(false);
    expect(inside(f.planes, [3, 20, 4])).toBe(false); // behind the camera
  });

  it('works for a wide f-theta lens', () => {
    const f = photoFrustum(
      { pos: [0, 10, 0], q: down },
      { model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 },
      [1280, 720],
    );
    expect(inside(f.planes, [0, 0, 0])).toBe(true);
    expect(inside(f.planes, [100, 0, 0])).toBe(false);
  });
});
