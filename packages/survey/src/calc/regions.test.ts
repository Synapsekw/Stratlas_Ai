import { describe, expect, it } from 'vitest';
import { ringArea } from '../engine/geometry';
import { draftRegions, simplify } from './regions';

describe('draft regions of a whole-site difference', () => {
  // 20 by 10 cells of 0.5 m: a fill block (cols 2..6, rows 2..5, +1 m), a cut L shape, noise
  const nx = 20;
  const ny = 10;
  const dz = new Float64Array(nx * ny).fill(0.01);
  for (let j = 2; j <= 5; j++) for (let i = 2; i <= 6; i++) dz[j * nx + i] = 1;
  for (let j = 1; j <= 8; j++) dz[j * nx + 12] = -0.5;
  for (let i = 12; i <= 17; i++) dz[8 * nx + i] = -0.5;
  dz[0] = Number.NaN;
  dz[9 * nx + 19] = 2; // a single cell: too small
  const g = { dz, nx, ny, x0: 1000, y0: 2000, cellM: 0.5 };

  it('finds the cut and fill areas with their outlines, areas and volumes', () => {
    const r = draftRegions(g, { minDepthM: 0.1 });
    expect(r.map((x) => x.kind)).toEqual(['fill', 'cut']);
    const fill = r[0];
    const cut = r[1];
    if (!fill || !cut) throw new Error('two regions');
    expect(fill.cells).toBe(20);
    expect(fill.areaM2).toBe(5);
    expect(fill.volumeM3).toBeCloseTo(5, 12);
    expect(fill.ring).toHaveLength(4);
    expect(ringArea(fill.ring)).toBeCloseTo(5, 9);
    expect(fill.ring).toContainEqual([1001, 2001]);
    expect(fill.ring).toContainEqual([1003.5, 2003]);
    expect(cut.cells).toBe(13);
    expect(cut.peakM).toBe(-0.5);
    expect(ringArea(cut.ring)).toBeCloseTo(13 * 0.25, 9);
    expect(cut.ring).toHaveLength(6);
  });

  it('the depth threshold and the minimum area leave out noise', () => {
    expect(draftRegions(g, { minDepthM: 3 })).toEqual([]);
    expect(draftRegions(g, { minDepthM: 0.1, minAreaM2: 4 }).map((x) => x.kind)).toEqual(['fill']);
    expect(draftRegions(g, { minDepthM: 0.005 })[0]?.cells).toBeGreaterThan(100);
  });

  it('simplify drops collinear corners', () => {
    expect(
      simplify(
        [
          [0, 0],
          [1, 0],
          [2, 0],
          [2, 1],
          [2, 2],
          [0, 2],
        ],
        0,
      ),
    ).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
  });
});
