import { shiftLocal, type DateShift, type Issue, type Vec3 } from '@aio/schema';
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

describe('footprintOf with a turned date', () => {
  it('follows a 0.5 degree turn', () => {
    const shift: DateShift = {
      eastM: 1,
      northM: 0.5,
      turn: {
        rotationDeg: 0.5,
        scale: 1,
        pivotE: 500050,
        pivotN: 3200050,
        pivotX: 50,
        pivotZ: -50,
      },
    };
    const pts = ring3(square(100, 100, 20));
    const i: Issue = {
      ...issue({ code: 'F01', layer: 'L', at: [0, 0, 0] }),
      sightings: [{ on: 'mesh', layer: 'L', geom: { type: 'spolygon', points: pts } }],
    };
    const hull = footprintOf(i, () => shift) ?? [];
    expect(hull).toHaveLength(4);
    const want = pts.map((p) => shiftLocal(p, shift));
    for (const [x, z] of hull)
      expect(want.some((w) => Math.abs(w[0] - x) < 1e-9 && Math.abs(w[2] - z) < 1e-9)).toBe(true);
  });
});
