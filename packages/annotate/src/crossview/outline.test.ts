import type { Vec2 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  convexHull2,
  densify,
  gridInside,
  hullWidth,
  mad,
  median,
  outlineOf,
  padHull,
  pointInRing,
  ringArea,
} from './outline';

const square: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('outlines', () => {
  it('outlines boxes, rotated boxes and polygons; not points or masks', () => {
    expect(outlineOf({ type: 'box', x: 1, y: 2, w: 3, h: 4 })).toEqual([
      [1, 2],
      [4, 2],
      [4, 6],
      [1, 6],
    ]);
    const rot = outlineOf({ type: 'rotbox', x: 0, y: 0, w: 4, h: 2, angleDeg: 90 }) ?? [];
    const xs = rot.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2, 9);
    expect(outlineOf({ type: 'polygon', points: square })).toEqual(square);
    expect(outlineOf({ type: 'point', x: 1, y: 1 })).toBeNull();
    expect(outlineOf({ type: 'mask', src: { path: 'm.png' } })).toBeNull();
  });

  it('densifies a closed ring every step pixels', () => {
    const d = densify(square, 8);
    expect(d).toHaveLength(8); // each 10 px edge in 2 steps
    expect(d[0]).toEqual([0, 0]);
    expect(d[1]).toEqual([5, 0]);
    expect(densify(square, 100)).toHaveLength(4);
  });

  it('lays an n x n grid inside the ring', () => {
    expect(gridInside(square, 7)).toHaveLength(49);
    const tri: Vec2[] = [
      [0, 0],
      [10, 0],
      [0, 10],
    ];
    const g = gridInside(tri, 7);
    expect(g.length).toBeGreaterThan(15);
    expect(g.length).toBeLessThan(35);
    expect(g.every((p) => pointInRing(p, tri))).toBe(true);
  });

  it('measures rings and hulls', () => {
    expect(ringArea(square)).toBe(100);
    expect(convexHull2([...square, [5, 5], [0, 0]])).toHaveLength(4);
    expect(hullWidth(convexHull2(square))).toBeCloseTo(10, 9);
  });

  it('pads a thin hull to the minimum width, and leaves a wide one alone', () => {
    const line: Vec2[] = [
      [0, 0],
      [5, 0.02],
      [10, 0],
    ];
    const padded = padHull(line, 0.1);
    expect(hullWidth(padded)).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(padHull(square, 0.1)).toEqual(convexHull2(square));
    expect(hullWidth(padHull([[3, 4]], 0.1))).toBeGreaterThanOrEqual(0.1 - 1e-9);
  });

  it('takes the median and the median absolute deviation', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100], 3)).toBe(1);
  });
});
