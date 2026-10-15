import type { Issue, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  areaXZ,
  clipConvex,
  convexHullXZ,
  footprintOf,
  footprintOverlap,
  type XZ,
} from './footprint';
import { issue } from './testing';

const square = (x: number, z: number, s: number): XZ[] => [
  [x, z],
  [x + s, z],
  [x + s, z + s],
  [x, z + s],
];
const ring3 = (pts: readonly XZ[], y = 0): Vec3[] => pts.map(([x, z]) => [x, y, z]);

describe('footprints', () => {
  it('builds the convex hull counter-clockwise without repeated points', () => {
    const hull = convexHullXZ([
      [0, 0],
      [2, 0],
      [1, 1],
      [2, 2],
      [0, 2],
      [0, 0],
    ]);
    expect(hull).toHaveLength(4);
    expect(areaXZ(hull)).toBeCloseTo(4, 9);
  });

  it('clips two convex polygons', () => {
    const inter = clipConvex(square(0, 0, 2), square(1, 1, 2));
    expect(areaXZ(inter)).toBeCloseTo(1, 9);
    expect(clipConvex(square(0, 0, 1), square(5, 5, 1))).toEqual([]);
  });

  it('measures overlap as the intersection over the smaller area', () => {
    expect(footprintOverlap(square(0, 0, 2), square(0, 0, 1))).toBeCloseTo(1, 9);
    expect(footprintOverlap(square(0, 0, 2), square(1, 1, 2))).toBeCloseTo(0.25, 9);
    expect(footprintOverlap(square(0, 0, 1), square(3, 3, 1))).toBe(0);
  });

  it('reads a mesh outline or a cloud prism, never a pin', () => {
    const pin = issue({ code: 'F01', layer: 'model-d1', at: [0, 0, 0] });
    expect(footprintOf(pin)).toBeNull();
    const outline: Issue = {
      ...pin,
      sightings: [
        {
          on: 'mesh',
          layer: 'model-d1',
          geom: { type: 'spolygon', points: ring3(square(0, 0, 1), 3) },
        },
      ],
    };
    expect(areaXZ(footprintOf(outline) ?? [])).toBeCloseTo(1, 9);
    const prism: Issue = {
      ...pin,
      sightings: [
        {
          on: 'pointcloud',
          layer: 'c',
          geom: { type: 'polygon3', points: ring3(square(0, 0, 2)), height: 1 },
        },
      ],
    };
    expect(areaXZ(footprintOf(prism) ?? [])).toBeCloseTo(4, 9);
  });
});
