import { describe, expect, it } from 'vitest';
import {
  boxFromDrag,
  cornersOf,
  dragHandle,
  fitView,
  geomOutline,
  hitGeom,
  rboxFromThreePoints,
  toDisplay,
  toImage,
  translateGeom,
  zoomAround,
} from './geometry';

describe('view transform', () => {
  it('fits an image into the viewport, centred', () => {
    const v = fitView({ width: 2000, height: 1000 }, { width: 1016, height: 1016 });
    expect(v.scale).toBeCloseTo(0.5);
    expect(v.y).toBeCloseTo((1016 - 1000 * v.scale) / 2);
  });

  it('round-trips image and display points', () => {
    const v = { scale: 2, x: 10, y: 20 };
    expect(toImage(toDisplay({ x: 3, y: 4 }, v), v)).toEqual({ x: 3, y: 4 });
  });

  it('zooms around the cursor, keeping the point under it', () => {
    const v = { scale: 1, x: 0, y: 0 };
    const z = zoomAround(v, { x: 100, y: 50 }, 2);
    expect(toImage({ x: 100, y: 50 }, z)).toEqual({ x: 100, y: 50 });
    expect(z.scale).toBe(2);
  });
});

describe('drawing', () => {
  const size = { width: 100, height: 100 };

  it('makes a box from a drag, clamped to the image', () => {
    expect(boxFromDrag({ x: 90, y: 10 }, { x: 120, y: 40 }, size)).toEqual({
      type: 'box',
      x: 90,
      y: 10,
      w: 10,
      h: 30,
    });
    expect(boxFromDrag({ x: 5, y: 5 }, { x: 6, y: 6 }, size)).toBeNull();
  });

  it('makes a rotated box from three points (Kestrel gesture)', () => {
    const r = rboxFromThreePoints({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 4 });
    expect(r).toEqual({ type: 'rotbox', x: 0, y: 0, w: 10, h: 4, angleDeg: 0 });
    const c = cornersOf({ type: 'rotbox', x: 0, y: 0, w: 10, h: 4, angleDeg: 90 });
    expect(c[0].x).toBeCloseTo(7);
    expect(c[0].y).toBeCloseTo(-3);
  });

  it('outlines every shape as a closed list of points', () => {
    expect(geomOutline({ type: 'box', x: 0, y: 0, w: 2, h: 1 })).toHaveLength(4);
    expect(geomOutline({ type: 'point', x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);
  });
});

describe('editing', () => {
  it('hits boxes, polygons and points', () => {
    expect(hitGeom({ type: 'box', x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5 }, 1)).toBe(true);
    expect(hitGeom({ type: 'box', x: 0, y: 0, w: 10, h: 10 }, { x: 15, y: 5 }, 1)).toBe(false);
    expect(
      hitGeom(
        {
          type: 'polygon',
          points: [
            [0, 0],
            [10, 0],
            [0, 10],
          ],
        },
        { x: 2, y: 2 },
        1,
      ),
    ).toBe(true);
    expect(hitGeom({ type: 'point', x: 0, y: 0 }, { x: 3, y: 0 }, 4)).toBe(true);
  });

  it('moves a shape', () => {
    expect(translateGeom({ type: 'point', x: 1, y: 1 }, 2, 3)).toEqual({
      type: 'point',
      x: 3,
      y: 4,
    });
  });

  it('drags a box corner handle and keeps the box positive', () => {
    const b = { type: 'box' as const, x: 0, y: 0, w: 10, h: 10 };
    expect(dragHandle(b, 2, { x: 20, y: 30 })).toEqual({ type: 'box', x: 0, y: 0, w: 20, h: 30 });
    expect(dragHandle(b, 0, { x: 20, y: 20 })).toEqual({ type: 'box', x: 10, y: 10, w: 10, h: 10 });
  });

  it('drags a polygon vertex', () => {
    const p = {
      type: 'polygon' as const,
      points: [
        [0, 0],
        [10, 0],
        [0, 10],
      ] as [number, number][],
    };
    expect(dragHandle(p, 1, { x: 12, y: 1 }).points[1]).toEqual([12, 1]);
  });
});
