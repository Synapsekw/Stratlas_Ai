import { describe, expect, it } from 'vitest';
import { LIGHT, MAX_DT, PARALLAX, pieceOffsets, pointerTarget, stepSpring } from './motion';

describe('springs', () => {
  it('settle on their target without running away', () => {
    const s = { x: 0, v: 0 };
    for (let i = 0; i < 240; i++) stepSpring(s, 1, PARALLAX.k, PARALLAX.d, 1 / 60);
    expect(s.x).toBeCloseTo(1, 2);
    const l = { x: 500, v: 0 };
    for (let i = 0; i < 240; i++) stepSpring(l, 100, LIGHT.k, LIGHT.d, 1 / 60);
    expect(l.x).toBeCloseTo(100, 0);
  });

  it('stay stable at the longest step the loop allows', () => {
    const s = { x: 0, v: 0 };
    for (let i = 0; i < 200; i++) stepSpring(s, 1, LIGHT.k, LIGHT.d, MAX_DT);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x - 1)).toBeLessThan(0.05);
  });
});

describe('the pieces', () => {
  it('stand still with the pointer at the centre', () => {
    for (const [dx, dy] of pieceOffsets(0, 0)) {
      expect(dx).toBeCloseTo(0);
      expect(dy).toBeCloseTo(0);
    }
  });

  it('move toward the pointer, the tail furthest', () => {
    const xs = pieceOffsets(1, 0).map(([dx]) => dx);
    expect(xs).toHaveLength(4);
    expect(xs[3]).toBeGreaterThan(Math.max(xs[0] ?? 0, xs[1] ?? 0, xs[2] ?? 0));
  });

  it('open the ring as the pointer leaves the centre: each piece moves out along its own diagonal', () => {
    const [nw, ne, sw, tail] = pieceOffsets(0, 1);
    expect(nw?.[0]).toBeLessThan(0);
    expect(ne?.[0]).toBeGreaterThan(0);
    expect(sw?.[0]).toBeLessThan(0);
    expect(tail?.[0]).toBeGreaterThan(0);
    // straight down: the two lower pieces travel further down than the two upper ones
    expect(sw?.[1]).toBeGreaterThan(nw?.[1] ?? 0);
    expect(tail?.[1]).toBeGreaterThan(ne?.[1] ?? 0);
  });

  it('read the pointer from the window centre', () => {
    expect(pointerTarget(720, 450, 1440, 900)).toEqual([0, 0]);
    expect(pointerTarget(0, 900, 1440, 900)).toEqual([-1, 1]);
    expect(pointerTarget(10, 10, 0, 0)).toEqual([0, 0]);
  });
});
