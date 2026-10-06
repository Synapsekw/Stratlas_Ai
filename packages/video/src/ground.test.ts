import type { Quat } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { groundPoint } from './ground';

const lens = { model: 'pinhole' as const, hfovDeg: 60, aspect: 1.5 };
/** Looking straight down (camera -z to world -y). */
const DOWN: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

describe('groundPoint', () => {
  it('meets the ground below a camera looking down', () => {
    const p = groundPoint({ pos: [3, 20, -4], q: DOWN, lens }, 0.5, 0.5);
    expect(p?.map((v) => Math.round(v * 1000) / 1000)).toEqual([3, 0, -4]);
    // the right edge of the frame lies east of the camera: 20 m x tan(30 deg)
    const r = groundPoint({ pos: [0, 20, 0], q: DOWN, lens }, 1, 0.5);
    expect(r?.[0]).toBeCloseTo(20 * Math.tan(Math.PI / 6), 6);
    expect(groundPoint({ pos: [0, 20, 0], q: DOWN, lens }, 0.5, 0.5, 5)?.[1]).toBe(5);
  });

  it('misses above the horizon and below the ground', () => {
    const level: Quat = [0, 0, 0, 1];
    expect(groundPoint({ pos: [0, 10, 0], q: level, lens }, 0.5, 0.1)).toBeNull();
    expect(groundPoint({ pos: [0, -1, 0], q: DOWN, lens }, 0.5, 0.5)).toBeNull();
  });
});
