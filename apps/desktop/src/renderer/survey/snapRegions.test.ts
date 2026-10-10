import { describe, expect, it } from 'vitest';
import {
  inRing,
  interiorPoint,
  regionWindow,
  ringBounds,
  ringIou,
  snapRegion,
  type Outline,
  type Ring,
} from './snapRegions';

const square = (x: number, y: number, s: number): [number, number][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];
const circle = (cx: number, cy: number, r: number, n = 48): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

describe('region geometry', () => {
  it('finds the bounds and tells inside from outside', () => {
    const sq = square(10, 20, 4);
    expect(ringBounds(sq)).toEqual([10, 20, 14, 24]);
    expect(inRing(sq, 12, 22)).toBe(true);
    expect(inRing(sq, 15, 22)).toBe(false);
  });

  it('picks a point well inside, also for a ring whose centre is outside', () => {
    const p = interiorPoint(circle(100, 200, 10));
    expect(Math.hypot((p?.[0] ?? 0) - 100, (p?.[1] ?? 0) - 200)).toBeLessThan(1.5);
    // an L: the bounds' centre (5, 5) is outside
    const l: Ring = [
      [0, 0],
      [10, 0],
      [10, 3],
      [3, 3],
      [3, 10],
      [0, 10],
    ];
    const q = interiorPoint(l);
    expect(q && inRing(l, q[0], q[1])).toBe(true);
    expect(interiorPoint([[0, 0]])).toBeNull();
  });

  it('measures how far two rings agree', () => {
    expect(ringIou(square(0, 0, 10), square(0, 0, 10))).toBeCloseTo(1, 2);
    expect(ringIou(square(0, 0, 10), square(5, 0, 10))).toBeCloseTo(1 / 3, 1);
    expect(ringIou(square(0, 0, 10), square(20, 0, 10))).toBe(0);
  });

  it('crops twice the region, within the limits', () => {
    const w = regionWindow(square(1000, 2000, 30));
    expect(w.res * w.size).toBeCloseTo(60, 9);
    expect(w.x0).toBeCloseTo(1015 - 30, 9);
    expect(w.y1).toBeCloseTo(2015 + 30, 9);
    expect(regionWindow(square(0, 0, 2)).res * 1024).toBeCloseTo(20, 9);
    expect(regionWindow(square(0, 0, 900)).res * 1024).toBeCloseTo(480, 9);
  });
});

describe('snapping a region to the ortho', () => {
  // the rule-based region: a blocky square around a pile the ortho shows as a circle
  const region = square(90, 190, 20);
  const pile = circle(100, 200, 10.5);

  it('takes the outline that agrees with the region', async () => {
    const calls: [number, number][] = [];
    const outline: Outline = (click) => {
      calls.push(click);
      return Promise.resolve({ ok: true, ring: pile, touchesEdge: false });
    };
    const r = await snapRegion(region, outline);
    expect(r.snapped).toBe(true);
    expect(r.ring).toBe(pile);
    expect(r.agreement).toBeGreaterThan(0.8);
    const [click] = calls;
    expect(click && inRing(region, click[0], click[1])).toBe(true);
  });

  it('keeps the region when the ortho shows something else, no edge, or nothing', async () => {
    const elsewhere = await snapRegion(region, () =>
      Promise.resolve({ ok: true, ring: circle(100, 200, 60), touchesEdge: false }),
    );
    expect(elsewhere).toMatchObject({ snapped: false, ring: region });
    expect(elsewhere.reason).toMatch(/does not match/);
    expect(elsewhere.agreement).toBeLessThan(0.5);
    const edge = await snapRegion(region, () =>
      Promise.resolve({ ok: true, ring: pile, touchesEdge: true }),
    );
    expect(edge).toMatchObject({ snapped: false });
    expect(edge.reason).toMatch(/no edge/);
    const none = await snapRegion(region, () =>
      Promise.resolve({ ok: false, error: 'No ortho is shown here.' }),
    );
    expect(none).toMatchObject({ snapped: false, reason: 'No ortho is shown here.' });
  });
});
