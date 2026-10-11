import { describe, expect, it } from 'vitest';
import { countsOf, type CloudCounts } from './stats';

const counts = (patch: Partial<CloudCounts>): CloudCounts => ({
  loaded: 0,
  total: 0,
  loading: 0,
  layers: 0,
  rgb: false,
  heightRange: null,
  ...patch,
});

describe('countsOf', () => {
  const left = {};
  const right = {};
  const byScene = new Map<object, CloudCounts>([
    [left, counts({ loaded: 100, layers: 1, heightRange: [2, 10], classes: { 2: 100 } })],
    [right, counts({ loaded: 40, layers: 1, heightRange: [5, 30], classes: { 2: 30, 6: 10 } })],
  ]);

  it('adds every view up when no view is named', () => {
    const all = countsOf(byScene);
    expect(all.loaded).toBe(140);
    expect(all.heightRange).toEqual([2, 30]);
    expect(all.classes).toEqual({ 2: 130, 6: 10 });
  });

  it('reads one view alone: each side of a comparison has its own range and classes', () => {
    expect(countsOf(byScene, left).heightRange).toEqual([2, 10]);
    expect(countsOf(byScene, right).heightRange).toEqual([5, 30]);
    expect(countsOf(byScene, right).classes).toEqual({ 2: 30, 6: 10 });
  });

  it('a view without clouds, or not there yet, counts nothing', () => {
    expect(countsOf(byScene, {}).loaded).toBe(0);
    expect(countsOf(byScene, {}).heightRange).toBeNull();
    expect(countsOf(byScene, null).loaded).toBe(0);
  });
});
