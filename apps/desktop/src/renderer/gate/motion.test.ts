import { describe, expect, it } from 'vitest';
import { LIGHT, MAX_DT, PARALLAX, plateOffsets, pointerTarget, stepSpring } from './motion';

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

describe('the plates', () => {
  it('stand still with the pointer at the centre', () => {
    for (const [dx, dy] of plateOffsets(0, 0)) {
      expect(dx).toBeCloseTo(0);
      expect(dy).toBeCloseTo(0);
    }
  });

  it('move toward the pointer, the top plate furthest', () => {
    const xs = plateOffsets(1, 0).map(([dx]) => dx);
    expect(xs).toHaveLength(4);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] ?? 0);
  });

  it('open the stack as the pointer leaves the centre', () => {
    const [bottom, , , top] = plateOffsets(1, 0);
    // the bottom plate moves down, the top one up: the gaps widen
    expect(bottom?.[1]).toBeGreaterThan(0);
    expect(top?.[1]).toBeLessThan(0);
  });

  it('read the pointer from the window centre', () => {
    expect(pointerTarget(720, 450, 1440, 900)).toEqual([0, 0]);
    expect(pointerTarget(0, 900, 1440, 900)).toEqual([-1, 1]);
    expect(pointerTarget(10, 10, 0, 0)).toEqual([0, 0]);
  });
});
