import type { WalkFit } from '@aio/geo';
import { describe, expect, it, vi } from 'vitest';
import { bearingFromHeadingRad, walkTrack } from './spotWalk';

/** A walk heading east along x at 1 m/s on ground 2 m high, fitted from 0 to `end` seconds. */
const fakeFit = (end = 10): WalkFit => ({
  at: (t) =>
    t >= 0 && t <= end ? { xz: [t, 0], groundY: 2, headingRad: -Math.PI / 2, dashed: false } : null,
  pins: [],
  gaps: [],
  pinsOnly: true,
  notToScale: false,
  error: null,
});

describe('bearingFromHeadingRad', () => {
  it('turns a three.js Ry heading into a compass bearing', () => {
    expect(bearingFromHeadingRad(0)).toBe(0);
    expect(bearingFromHeadingRad(-Math.PI / 2)).toBeCloseTo(90);
    expect(bearingFromHeadingRad(Math.PI / 2)).toBeCloseTo(270);
  });
});

describe('walkTrack', () => {
  it('samples the camera over the fitted ground every second', () => {
    const s = walkTrack(fakeFit(), 10, 1.7, () => -Math.PI / 2);
    expect(s.map((x) => x.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const x of s) {
      expect(x.pos[0]).toBe(x.t);
      expect(x.pos[1]).toBeCloseTo(3.7);
      expect(x.pos[2]).toBe(0);
      expect(x.groundY).toBe(2);
      expect(x.bearingDeg).toBeCloseTo(90);
    }
  });

  it("uses the view heading, else the fit's travel heading", () => {
    const viewed = walkTrack(fakeFit(), 2, 1.7, () => Math.PI / 2);
    expect(viewed.every((x) => Math.abs(x.bearingDeg - 270) < 1e-9)).toBe(true);
    const fallback = walkTrack(fakeFit(), 2, 1.7, () => null);
    expect(fallback.every((x) => Math.abs(x.bearingDeg - 90) < 1e-9)).toBe(true);
  });

  it('leaves out the seconds the fit does not cover', () => {
    const s = walkTrack(fakeFit(4), 10, 1.7, () => null);
    expect(s.map((x) => x.t)).toEqual([0, 1, 2, 3, 4]);
  });

  it('stands on the ground it is given, else on the fitted ground', () => {
    // the drawn ground rises along x and stops at x = 5
    const s = walkTrack(
      fakeFit(),
      10,
      1.7,
      () => null,
      (x) => (x <= 5 ? 10 + x : null),
    );
    for (const x of s) {
      const ground = x.t <= 5 ? 10 + x.t : 2;
      expect(x.groundY).toBeCloseTo(ground, 9);
      expect(x.pos[1]).toBeCloseTo(ground + 1.7, 9);
    }
  });

  it("asks the ground near the walk's fitted height, so a roof over it is skipped", () => {
    const groundAt = vi.fn(() => 1);
    walkTrack(fakeFit(), 1, 1.7, () => null, groundAt);
    expect(groundAt).toHaveBeenCalledWith(0, 0, 2);
  });

  it('steps at the given step', () => {
    expect(walkTrack(fakeFit(), 4, 1.7, () => null, undefined, 2).map((x) => x.t)).toEqual([
      0, 2, 4,
    ]);
  });
});
