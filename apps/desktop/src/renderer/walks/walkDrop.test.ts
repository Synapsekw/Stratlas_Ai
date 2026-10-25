import { describe, expect, it, vi } from 'vitest';
import { MIN_WALK_FLOOR_HITS, walkFloorShift } from './walkDrop';

/** A straight walk 40 m east at stored ground `y`, a point every 0.25 m. */
const line = (y: number): [number, number, number][] =>
  Array.from({ length: 161 }, (_, i) => [i * 0.25, y, 0]);

describe('walkFloorShift', () => {
  it('a walk placed on the map (ground 0) over a floor 1.25 m up moves up 1.25 m', () => {
    const r = walkFloorShift([line(0)], () => 1.25);
    expect(r?.shift).toBeCloseTo(1.25, 9);
    expect(r?.hits).toBeGreaterThan(30);
  });

  it('a walk whose pins sit on a roof 6 m over the floor moves down', () => {
    const r = walkFloorShift([line(6)], () => 0);
    expect(r?.shift).toBeCloseTo(-6, 9);
  });

  it('takes the median: a few stray answers (a step, a table) do not move it', () => {
    const r = walkFloorShift([line(0)], (x) => (x > 35 ? 3 : 1));
    expect(r?.shift).toBe(1);
  });

  it('ignores the misses where nothing is drawn', () => {
    const r = walkFloorShift([line(0)], (x) => (x < 20 ? null : 2));
    expect(r?.shift).toBe(2);
  });

  it('answers null when too few samples hit a floor', () => {
    let n = 0;
    const r = walkFloorShift([line(0)], () => (n++ < MIN_WALK_FLOOR_HITS - 1 ? 1 : null));
    expect(r).toBeNull();
    expect(walkFloorShift([line(0)], () => null)).toBeNull();
    expect(walkFloorShift([], () => 1)).toBeNull();
  });

  it('asks the floor near the walk’s own stored ground, and at most the given number of times', () => {
    const ground = vi.fn((_x: number, _z: number, near?: number) => (near ?? 0) + 0.5);
    const long = Array.from(
      { length: 4001 },
      (_, i) => [i * 0.25, 3, 0] as [number, number, number],
    );
    const r = walkFloorShift([long], ground, 100);
    expect(r?.shift).toBeCloseTo(0.5, 9);
    expect(ground.mock.calls.length).toBeLessThanOrEqual(100);
    expect(ground.mock.calls.every((c) => c[2] === 3)).toBe(true);
  });
});
