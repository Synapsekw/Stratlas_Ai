import { describe, expect, it } from 'vitest';
import { densify, ringArea, spans, type EN } from './edit';

const square = (x0: number, y0: number, s: number): EN[] => [
  [x0, y0],
  [x0 + s, y0],
  [x0 + s, y0 + s],
  [x0, y0 + s],
];

describe('ring helpers', () => {
  it('measures a ring area whatever its winding', () => {
    expect(ringArea(square(0, 0, 10))).toBe(100);
    expect(ringArea([...square(0, 0, 10)].reverse())).toBe(100);
  });

  it('finds the sorted crossings of a row', () => {
    expect(spans(square(2, 0, 4), 1)).toEqual([2, 6]);
    expect(spans(square(2, 0, 4), 7)).toEqual([]);
  });

  it('densifies every edge to the step', () => {
    const d = densify(square(0, 0, 2), 0.5);
    expect(d).toHaveLength(16);
    expect(d[1]).toEqual([0.5, 0]);
  });
});
