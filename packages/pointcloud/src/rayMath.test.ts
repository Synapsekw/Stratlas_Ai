import { describe, expect, it } from 'vitest';
import { pointsInPrismOf, raycastPoints, type RayChunk } from './rayMath';

// a row of points along z at x = 0, y = 0, and one off to the side
const row: RayChunk = { positions: new Float32Array([0, 0, 0, 0, 0, -5, 0, 0, -10, 0.5, 0, -2]) };
const down = { origin: [0, 0, 10] as const, dir: [0, 0, -1] as const };

describe('raycastPoints', () => {
  it('returns the nearest point along the ray inside the cone', () => {
    const hit = raycastPoints(down, [row], { coneRad: 0.001 });
    expect(hit).toMatchObject({ chunk: 0, index: 0, point: [0, 0, 0] });
    expect(hit?.t).toBeCloseTo(10, 6);
  });

  it('widens with distance: a point 0.5 m off the ray is hit only by a wide enough cone', () => {
    const side = { origin: [0.5, 0, 10] as const, dir: [0, 0, -1] as const };
    // straight through (0.5, 0, -2): the nearest point along this ray
    expect(raycastPoints(side, [row], { coneRad: 0.001 })?.index).toBe(3);
    const off = { origin: [1.5, 0, 10] as const, dir: [0, 0, -1] as const };
    expect(raycastPoints(off, [row], { coneRad: 0.001 })).toBeNull();
    // 1 m off at t = 12: needs coneRad >= 1 / 12
    expect(raycastPoints(off, [row], { coneRad: 0.09 })?.index).toBe(3);
  });

  it('keeps an absolute floor for points close to the camera, raised by the chunk spacing', () => {
    const near: RayChunk = { positions: new Float32Array([0.02, 0, 9.5]) };
    expect(raycastPoints(down, [near], { coneRad: 0 })).toBeNull();
    expect(raycastPoints(down, [near], { coneRad: 0, floor: 0.03 })?.index).toBe(0);
    expect(raycastPoints(down, [{ ...near, floor: 0.03 }], { coneRad: 0 })?.index).toBe(0);
  });

  it('skips points behind the camera, past maxDist and those keep rejects', () => {
    const behind: RayChunk = { positions: new Float32Array([0, 0, 20]) };
    expect(raycastPoints(down, [behind], { coneRad: 0.01 })).toBeNull();
    expect(raycastPoints(down, [row], { coneRad: 0.001, maxDist: 9 })).toBeNull();
    const keep: RayChunk = { ...row, keep: (_x, _y, z) => z < -1 };
    expect(raycastPoints(down, [keep], { coneRad: 0.001 })?.index).toBe(1);
  });

  it('applies the chunk matrix (column-major) and reports chunk-space indices', () => {
    // translate the row by +3 in x
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1];
    const moved: RayChunk = { ...row, matrix: m };
    const ray = { origin: [3, 0, 10] as const, dir: [0, 0, -2] as const };
    const hit = raycastPoints(ray, [row, moved], { coneRad: 0.001 });
    expect(hit).toMatchObject({ chunk: 1, index: 0, point: [3, 0, 0] });
  });
});

describe('raycastPoints chunk culling', () => {
  /** Positions that count how often they are read. */
  function counted(values: number[]) {
    const reads = { n: 0 };
    const arr = new Float32Array(values);
    const positions = new Proxy(arr, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads.n++;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return { positions, reads };
  }

  it('never scans a chunk whose sphere the cone cannot reach, and finds the same hit', () => {
    const far = counted([50, 0, 0, 50, 0, -5]);
    const behind = counted([0, 0, 30, 0, 0, 40]);
    const farChunk: RayChunk = {
      positions: far.positions,
      sphere: { center: [50, 0, -2.5], radius: 2.5 },
    };
    const behindChunk: RayChunk = {
      positions: behind.positions,
      sphere: { center: [0, 0, 35], radius: 5 },
    };
    const rowChunk: RayChunk = { ...row, sphere: { center: [0.25, 0, -5], radius: 5.1 } };
    const culled = raycastPoints(down, [farChunk, behindChunk, rowChunk], { coneRad: 0.001 });
    expect(far.reads.n).toBe(0);
    expect(behind.reads.n).toBe(0);
    const plain = raycastPoints(down, [row], { coneRad: 0.001 });
    expect(culled).toEqual({ ...plain, chunk: 2 });
    expect(culled?.index).toBe(0);
  });
});

describe('pointsInPrismOf', () => {
  it('returns the points inside the plan-view ring and the height range, in the local frame', () => {
    const pts: RayChunk = {
      positions: new Float32Array([0, 0, 0, 0, 2, 0, 5, 0, 0, 0.2, 0.5, 0.2]),
    };
    const ring = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const;
    const out = pointsInPrismOf([pts], { ring, minY: -0.1, maxY: 1 });
    expect([...out]).toEqual([0, 0, 0, 0.2, 0.5, 0.2].map((v) => Math.fround(v)));
  });
});
