import { describe, expect, it } from 'vitest';
import type { PoseSample } from '@aio/schema';
import { interpolatePose } from './pose';

const id: [number, number, number, number] = [0, 0, 0, 1];
const s: PoseSample[] = [
  { t: 0, pos: [0, 0, 0], q: id },
  { t: 1000, pos: [10, 20, 30], q: id },
];

describe('interpolatePose', () => {
  it('interpolates position linearly', () => {
    expect(interpolatePose(s, 500).pos).toEqual([5, 10, 15]);
  });
  it('clamps outside the log', () => {
    expect(interpolatePose(s, -5).pos).toEqual([0, 0, 0]);
    expect(interpolatePose(s, 5000).pos).toEqual([10, 20, 30]);
  });
  it('keeps unit quaternions', () => {
    const q = interpolatePose(
      [
        { t: 0, pos: [0, 0, 0], q: [0, 0, 0, 1] },
        { t: 10, pos: [0, 0, 0], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
      ],
      5,
    ).q;
    expect(Math.hypot(...q)).toBeCloseTo(1, 9);
  });
  it('throws on an empty log', () => {
    expect(() => interpolatePose([], 0)).toThrow('at least one pose sample');
  });
});
