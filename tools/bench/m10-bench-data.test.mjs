import { describe, expect, it } from 'vitest';
import { MAX_CELL_POINTS, planBench } from './m10-bench-data.mjs';

describe('planBench (the opt-in M10 benchmark data)', () => {
  it('reaches 20 M triangles on the leaves of a depth 6 quadtree', () => {
    const p = planBench({ points: 100e6, triangles: 20e6 });
    expect(p.depth).toBe(6);
    expect(p.leaves).toBe(1024);
    expect(p.tiles).toBe(1365);
    expect(p.quads).toBeLessThanOrEqual(100);
    expect(p.leaves * 2 * p.quads ** 2).toBeGreaterThanOrEqual(20e6);
    expect(p.leafTriangles).toBe(p.leaves * 2 * p.quads ** 2);
  });

  it('cuts 100 M points into whole octree cells of at most 10 M', () => {
    const p = planBench({ points: 100e6, triangles: 20e6 });
    expect(p.cells).toBe(16);
    expect(p.pointsPerCell).toBeLessThanOrEqual(MAX_CELL_POINTS);
    expect(p.cells * p.pointsPerCell).toBeGreaterThanOrEqual(100e6);
  });

  it('cuts 500 M points into 64 cells, and a small cloud into one', () => {
    const big = planBench({ points: 500e6, triangles: 20e6 });
    expect(big.cells).toBe(64);
    expect(big.pointsPerCell).toBeLessThanOrEqual(MAX_CELL_POINTS);
    expect(planBench({ points: 5e6, triangles: 20e6 }).cells).toBe(1);
  });
});
