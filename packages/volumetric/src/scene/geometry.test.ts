import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { BodyCells } from '../model/bodies';
import { bodyGeometry, swipePlane, toLocalFn } from './geometry';

function cells(): BodyCells {
  // 3 x 2 cells of 1 m, the last column outside
  return {
    nx: 3,
    ny: 2,
    cell: 1,
    e0: 100.5,
    n0: 200.5,
    ins: Uint8Array.from([1, 1, 0, 1, 1, 0]),
    top: Float32Array.from([12, 13, 0, 12, 12.05, 0]),
    bot: Float32Array.from([10, 10, 0, 10, 12, 0]),
    d: Float32Array.from([-1, 2, 0, -1, 0.5, 0]),
    tmax: 13,
    bmin: 10,
  };
}

describe('toLocalFn', () => {
  it('maps easting, northing and height into the local frame', () => {
    expect(toLocalFn([100, 200, 10])(101, 199, 12)).toEqual([1, 2, 1]);
  });
});

describe('bodyGeometry', () => {
  const local = toLocalFn([100, 200, 10]);

  it('draws quads where all four cells are inside, top above base', () => {
    const g = bodyGeometry(cells(), local, { lifted: false, change: false });
    expect(Array.from(g.index)).toHaveLength(6);
    // cell (0, 0): E 100.5 N 200.5 top 12 -> local (0.5, 2.12, -0.5) (lifted by 0.12 m when in place)
    expect(g.top[0]).toBeCloseTo(0.5, 6);
    expect(g.top[1]).toBeCloseTo(2.12, 6);
    expect(g.top[2]).toBeCloseTo(-0.5, 6);
    expect(g.bottom[1]).toBeCloseTo(0, 6);
    expect(g.lift).toBe(0);
    expect(g.colors).toBeNull();
  });

  it('lifts the body clear of the pile and hatches top to base every metre', () => {
    const g = bodyGeometry(cells(), local, { lifted: true, change: false });
    expect(g.lift).toBe(6); // 13 - 10 + 3
    expect(g.top[1]).toBeCloseTo(8, 6);
    expect(g.bottom[1]).toBeCloseTo(6, 6);
    // three hatch posts: the 0.05 m cell is too thin
    expect(g.hatch.length).toBe(3 * 6);
  });

  it('colours change bodies by the sign of the change', () => {
    const g = bodyGeometry(cells(), local, { lifted: false, change: true });
    expect(g.colors?.[0]).toBeGreaterThan(g.colors?.[2] ?? 1);
    expect(g.colors?.[5]).toBeGreaterThan(g.colors?.[3] ?? 1);
  });
});

describe('swipePlane', () => {
  it('keeps what is right of the divider', () => {
    const cam = new PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const centre = swipePlane(cam, 0.5);
    expect(centre.distanceToPoint(new Vector3(1, 0, 0))).toBeGreaterThan(0);
    expect(centre.distanceToPoint(new Vector3(-1, 0, 0))).toBeLessThan(0);
    const left = swipePlane(cam, 0.25);
    expect(left.distanceToPoint(new Vector3(-1, 0, 0))).toBeGreaterThan(0);
  });
});
