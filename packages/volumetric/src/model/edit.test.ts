import { describe, expect, it } from 'vitest';
import { densify, editGeometry, editVolumes, ringArea, simplifyRing, spans, type EN } from './edit';

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

  it('simplifies a dense line to its corners, keeping at least four points', () => {
    const dense = densify(square(0, 0, 20), 0.5);
    const s = simplifyRing(dense, 0.6);
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s.length).toBeLessThan(10);
    for (const c of square(0, 0, 20)) expect(s).toContainEqual(c);
  });

  it('leaves short rings alone', () => {
    expect(simplifyRing(square(0, 0, 5), 0.6)).toEqual(square(0, 0, 5));
  });
});

describe('editGeometry and editVolumes', () => {
  // floor at 50 m with a 4 x 4 m block 2 m high in the middle of a 10 x 10 m ring
  const surf = (E: number, N: number) => (E > 3 && E < 7 && N > 3 && N < 7 ? 52 : 50);

  it('fits the four bases to the floor along the edited line', () => {
    const g = editGeometry(square(0, 0, 10), surf);
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.low).toBeCloseTo(50, 9);
    expect(g.avg).toBeCloseTo(50, 9);
    expect(g.baseAt('plane', 5, 5)).toBeCloseTo(50, 6);
    expect(g.baseAt('tin', 5, 5)).toBeCloseTo(50, 6);
  });

  it('counts what stands above each base on the 10 cm job grid', () => {
    const g = editGeometry(square(0, 0, 10), surf);
    if (!g) throw new Error('no geometry');
    const r = editVolumes(g, 0, 100);
    for (const b of ['tin', 'plane', 'avg', 'low'] as const) {
      expect(r.volumes[b].fill).toBeCloseTo(32, 0);
      expect(r.volumes[b].cut).toBe(0);
    }
    expect(r.areaM2).toBeCloseTo(100, 0);
    expect(r.topM).toBe(52);
    expect(r.heightM).toBeCloseTo(2, 2);
  });

  it('raises the bases when the line climbs the pile', () => {
    // line inside the block: every boundary sample sits on top of the block
    const g = editGeometry(square(3.5, 3.5, 3), surf);
    if (!g) throw new Error('no geometry');
    expect(g.low).toBe(52);
    expect(editVolumes(g, 0, 100).volumes.low.fill).toBeCloseTo(0, 6);
  });

  it('gives up when the line has no surface under it', () => {
    expect(editGeometry(square(0, 0, 10), () => null)).toBeNull();
  });
});
