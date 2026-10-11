import { QUARTER, quarterBounds } from '@aio/brand';
import { describe, expect, it } from 'vitest';
import {
  frameAt,
  getMotion,
  insetPolygon,
  motionLength,
  POINTS,
  resamplePolygon,
  restFrame,
} from './brandMotionEngine';

const points = (d: string) =>
  d
    .replace(/[MZ]/g, '')
    .split('L')
    .map((s) => s.trim().split(' ').map(Number) as [number, number]);

describe('polygons', () => {
  it('inset a clockwise square inward', () => {
    expect(
      insetPolygon(
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        1,
      ),
    ).toEqual([
      [1, 1],
      [9, 1],
      [9, 9],
      [1, 9],
    ]);
  });
  it('resample to a fixed count and keep every corner', () => {
    const out = resamplePolygon(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      POINTS,
    );
    expect(out).toHaveLength(POINTS);
    for (const c of [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
      expect(out.some(([x, y]) => x === c[0] && y === c[1])).toBe(true);
    // the first point is the one up and to the left of the centre
    expect(out[0]).toEqual([0, 0]);
  });
});

describe('the rest pose', () => {
  it('is four pieces of the same shape as the still mark', () => {
    const rest = restFrame();
    expect(rest).toHaveLength(4);
    const b = quarterBounds(QUARTER);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const piece of rest)
      for (const [x, y] of points(piece.d)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    // polygons are inset by the corner radius and the round stroke puts it back; the rounded
    // corners stop 0.06 short of the ring's nominal edge and the twelve chords of a quarter
    // another 0.05, hence the tolerance
    const near = (got: number, want: number) => {
      expect(Math.abs(got - want)).toBeLessThan(0.12);
    };
    near(x0 - QUARTER.corner, b.x);
    near(y0 - QUARTER.corner, b.y);
    near(x1 + QUARTER.corner, b.x + b.w);
    near(y1 + QUARTER.corner, b.y + b.h);
    for (const piece of rest) expect(piece).toMatchObject({ opacity: 1, rot: 0, halo: 0 });
  });
});

describe('motions', () => {
  it('Step out starts on the closed ring and ends on the mark in about a second', () => {
    const m = getMotion('stepOut');
    expect(motionLength(m)).toBe(980);
    const first = frameAt(m, 0);
    expect(first.done).toBe(false);
    expect(first.pieces[3]?.d).not.toBe(restFrame()[3]?.d);
    // the three quarters do not move
    expect(first.pieces[0]?.d).toBe(restFrame()[0]?.d);
    const end = frameAt(m, 980);
    expect(end.done).toBe(true);
    expect(end.pieces.map((p) => p.d)).toEqual(restFrame().map((p) => p.d));
  });

  it('the sequence passes through four forms and ends on the mark', () => {
    const m = getMotion('sequence');
    expect(m.poses.map((p) => p.label)).toEqual(['Map', 'Model', 'Dates', 'Globe', 'Quarter']);
    expect(motionLength(m)).toBe(4865);
    expect(frameAt(m, 0).pieces.map((p) => p.d)).toEqual(restFrame().map((p) => p.d));
    expect(frameAt(m, 5000).done).toBe(true);
    // in the model the plate lifts off the cube: a halo keeps it apart
    const model = frameAt(m, 685 + 360 + 685).pieces;
    expect(model[3]?.halo).toBeCloseTo(2.2);
    expect(model[1]?.opacity).toBeCloseTo(0.5);
  });

  it('Quarter turns loops, a quarter at a time, and never reports done', () => {
    const m = getMotion('turns');
    expect(m.loops).toBe(true);
    const loop = motionLength(m);
    expect(loop).toBe(4 * (520 + 3 * 45 + 200));
    expect(frameAt(m, loop / 4 - 1).pieces[0]?.rot).toBeCloseTo(90, 0);
    expect(frameAt(m, loop * 3 + 10).done).toBe(false);
    // the same moment one loop later looks the same
    expect(frameAt(m, 300).pieces[3]?.rot).toBeCloseTo(frameAt(m, 300 + loop).pieces[3]?.rot ?? -1);
  });

  it('never produces a broken path', () => {
    for (const name of ['stepOut', 'turns', 'sequence'] as const) {
      const m = getMotion(name);
      for (let ms = 0; ms <= motionLength(m); ms += 37)
        for (const p of frameAt(m, ms).pieces) expect(p.d).not.toMatch(/NaN|undefined/);
    }
  });

  it('never folds a piece over on its way between two forms', () => {
    // shoelace area: positive while the outline runs clockwise, as every pose does. Two forms
    // whose points did not line up would cross on the way and the area would collapse
    const area = (p: readonly (readonly [number, number])[]) => {
      let a = 0;
      p.forEach(([x, y], i) => {
        const [nx, ny] = p[(i + 1) % p.length] ?? [0, 0];
        a += x * ny - nx * y;
      });
      return a / 2;
    };
    for (const name of ['stepOut', 'sequence'] as const) {
      const m = getMotion(name);
      const smallest = [0, 1, 2, 3].map((i) =>
        Math.min(...[m.rest, ...m.poses].map((pose) => area(pose.pts[i] ?? []))),
      );
      for (let ms = 0; ms <= motionLength(m); ms += 9)
        frameAt(m, ms).pieces.forEach((p, i) => {
          expect(area(points(p.d))).toBeGreaterThan(0.9 * (smallest[i] ?? Infinity));
        });
    }
  });
});
