import type { SitePoint } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { moveAxisEnd, pileAxis, rotateAxis } from './pileAxis';

/** A w x h rectangle centred on (cx, cy), its long side turned `deg` clockwise from east. */
function rect(w: number, h: number, deg: number, cx = 500, cy = 300): SitePoint[] {
  const r = (deg * Math.PI) / 180;
  const ux = Math.cos(r);
  const uy = -Math.sin(r);
  const vx = Math.sin(r);
  const vy = Math.cos(r);
  const corners: [number, number][] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  return corners.map(([s, t]) => [cx + s * ux + t * vx, cy + s * uy + t * vy, 10]);
}

describe('pileAxis', () => {
  it('finds the long axis of a 100 x 20 rectangle turned 30 degrees', () => {
    const axis = pileAxis(rect(100, 20, 30));
    expect(axis.angleDeg).toBeCloseTo(30, 2);
    expect(Math.abs(axis.angleDeg - 30)).toBeLessThan(0.01);
    expect(Math.abs(axis.lengthM - 110)).toBeLessThan(0.01);
    expect(axis.centre[0]).toBeCloseTo(500, 6);
    expect(axis.centre[1]).toBeCloseTo(300, 6);
    const len = Math.hypot(axis.b[0] - axis.a[0], axis.b[1] - axis.a[1]);
    expect(len).toBeCloseTo(axis.lengthM, 6);
  });

  it('keeps the angle in [0, 180) for a pile turned past 90 degrees', () => {
    const axis = pileAxis(rect(100, 20, 150));
    expect(axis.angleDeg).toBeCloseTo(150, 2);
    const flipped = pileAxis(rect(100, 20, 210));
    expect(flipped.angleDeg).toBeCloseTo(30, 2);
  });

  it('gives a square a stable angle of 0', () => {
    const axis = pileAxis(rect(40, 40, 0));
    expect(axis.angleDeg).toBe(0);
    expect(axis.lengthM).toBeCloseTo(44, 6);
  });

  it('honours the angleDeg option and the margin', () => {
    const axis = pileAxis(rect(100, 20, 0), { angleDeg: 90, marginPct: 0 });
    expect(axis.angleDeg).toBe(90);
    expect(axis.lengthM).toBeCloseTo(20, 6);
  });

  it('rotateAxis by 90 swaps to the short extent', () => {
    const ring = rect(100, 20, 30);
    const turned = rotateAxis(pileAxis(ring), ring, 90);
    expect(turned.angleDeg).toBeCloseTo(120, 6);
    expect(turned.lengthM).toBeCloseTo(22, 6);
  });

  it('moveAxisEnd keeps the other end and recomputes the length', () => {
    const axis = pileAxis(rect(100, 20, 0));
    const moved = moveAxisEnd(axis, 'b', [axis.a[0], axis.a[1] + 30]);
    expect(moved.a).toEqual(axis.a);
    expect(moved.b).toEqual([axis.a[0], axis.a[1] + 30]);
    expect(moved.lengthM).toBeCloseTo(30, 6);
    expect(moved.angleDeg).toBeCloseTo(90, 6);
    const movedA = moveAxisEnd(axis, 'a', [axis.b[0] - 10, axis.b[1]]);
    expect(movedA.b).toEqual(axis.b);
    expect(movedA.lengthM).toBeCloseTo(10, 6);
  });
});
