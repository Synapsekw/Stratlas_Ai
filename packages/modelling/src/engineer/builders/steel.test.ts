import type { AssemblyParams } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { Prim } from '../geom';
import {
  bounds,
  boundaryLoops,
  closedAndWound,
  degenerateTriangles,
  must,
  normalsAgree,
  normalsUnit,
} from '../testGeom';
import { braceCount, latticeLegAt, STEEL_BUILDERS } from './steel';
import { build, countComponents, registerBuilders } from './testFixtures';

registerBuilders(STEEL_BUILDERS);

/** Closed, outward-wound pieces with unit normals and no sliver triangles. */
function expectSolid(p: Prim): void {
  expect(closedAndWound(p)).toBe(true);
  expect(normalsAgree(p)).toBe(true);
  expect(normalsUnit(p)).toBe(true);
  expect(degenerateTriangles(p)).toBe(0);
  expect(boundaryLoops(p)).toEqual([]);
}

const only = (prims: Prim[]): Prim => {
  expect(prims).toHaveLength(1);
  return must(prims[0], 'primitive');
};

function lattice(
  bays: number,
  bracing: 'X' | 'K' | 'Z',
  legs: 3 | 4 = 4,
  bayHeight = 5,
): AssemblyParams<'lattice'> {
  return {
    base: [0, 0, 0],
    legs,
    widthBase: 8,
    widthTop: 2,
    height: bays * bayHeight,
    bays: Array.from({ length: bays }, () => ({ height: bayHeight, bracing })),
    legSection: 0.2,
    braceSection: 0.1,
  };
}

describe('lattice', () => {
  it('four-leg lattice tapers from widthBase to widthTop', () => {
    const p: AssemblyParams<'lattice'> = lattice(8, 'X');
    expect(latticeLegAt(p, 0).map((v) => Math.hypot(v[0], v[2]))).toEqual(
      Array(4).fill(Math.SQRT2 * 4),
    );
    expect(latticeLegAt(p, 40).map((v) => +Math.hypot(v[0], v[2]).toFixed(6))).toEqual(
      Array(4).fill(+(Math.SQRT2 * 1).toFixed(6)),
    );
    // half way up the half-width is half way between 4 and 1
    expect(latticeLegAt(p, 20).map((v) => +Math.hypot(v[0], v[2]).toFixed(6))).toEqual(
      Array(4).fill(+(Math.SQRT2 * 2.5).toFixed(6)),
    );
  });

  it('legs stand at 45, 135, 225 and 315 degrees, or 90, 210 and 330 for three', () => {
    const deg = (v: number[]) =>
      +(((Math.atan2(must(v[2]), must(v[0])) * 180) / Math.PI + 360) % 360).toFixed(6);
    expect(latticeLegAt(lattice(2, 'X'), 0).map(deg)).toEqual([45, 135, 225, 315]);
    const three = lattice(2, 'X', 3);
    expect(latticeLegAt(three, 0).map(deg)).toEqual([90, 210, 330]);
    // face width is the leg spacing
    const [a, b] = latticeLegAt(three, 0);
    expect(Math.hypot(must(a)[0] - must(b)[0], must(a)[2] - must(b)[2])).toBeCloseTo(8, 9);
  });

  it('leg points sit at the base height plus y and follow a moved base', () => {
    const p = { ...lattice(2, 'X'), base: [10, 5, -3] as [number, number, number] };
    for (const v of latticeLegAt(p, 7)) {
      expect(v[1]).toBe(7);
      expect(Math.hypot(v[0] - 10, v[2] + 3)).toBeCloseTo(Math.SQRT2 * (4 - (3 * 2) / 10), 9);
    }
  });

  it('X bracing gives two braces per face per bay, K gives two, Z gives one', () => {
    expect(braceCount({ legs: 4, bays: [{ bracing: 'X' }] })).toBe(8);
    expect(braceCount({ legs: 4, bays: [{ bracing: 'K' }] })).toBe(8);
    expect(braceCount({ legs: 3, bays: [{ bracing: 'Z' }] })).toBe(3);
    expect(braceCount({ legs: 3, bays: [{ bracing: 'X' }, { bracing: 'Z' }] })).toBe(9);
  });

  it.each(['X', 'K', 'Z'] as const)(
    '%s bracing builds legs, a horizontal per face per bay and the braces, all closed',
    (bracing) => {
      for (const legs of [3, 4] as const) {
        const p = lattice(6, bracing, legs);
        const prim = only(build('lattice', p).out());
        expectSolid(prim);
        expect(prim.material).toBe('steel-galv');
        expect(countComponents(prim)).toBe(legs + legs * 6 + braceCount(p));
      }
    },
  );

  it('member counts follow mixed bracing from the params', () => {
    const p: AssemblyParams<'lattice'> = {
      ...lattice(3, 'X'),
      bays: [
        { height: 5, bracing: 'X' },
        { height: 5, bracing: 'K' },
        { height: 5, bracing: 'Z' },
      ],
    };
    expect(braceCount(p)).toBe(4 * (2 + 2 + 1));
    expect(countComponents(only(build('lattice', p).out()))).toBe(4 + 12 + 20);
  });

  it('stays inside the tapered footprint and reaches the top', () => {
    const p = lattice(8, 'X');
    const b = bounds(only(build('lattice', p).out()));
    // legs are round bars of radius 0.1 round the leg line; nothing reaches past them
    expect(b.max[0]).toBeLessThanOrEqual(4 + 0.1 + 1e-9);
    expect(b.min[0]).toBeGreaterThanOrEqual(-4 - 0.1 - 1e-9);
    expect(b.max[0]).toBeGreaterThan(4);
    // the leaning legs' end caps dip a little below the base, never by a whole section
    expect(b.min[1]).toBeLessThanOrEqual(0);
    expect(b.min[1]).toBeGreaterThan(-0.1);
    expect(b.max[1]).toBeGreaterThanOrEqual(40);
    expect(b.max[1]).toBeLessThan(40 + 0.1);
  });

  it('lattice of 80 bays stays within the triangle budget at every detail', () => {
    const p = lattice(80, 'X', 4, 1);
    const budget = { fast: 150_000, standard: 400_000, detailed: 900_000 } as const;
    for (const detail of ['fast', 'standard', 'detailed'] as const) {
      const s = build('lattice', p, { detail });
      expect(s.triangles()).toBeLessThan(budget[detail]);
      expect(s.triangles()).toBeGreaterThan(0);
    }
    expect(build('lattice', p).triangles()).toBeLessThan(150_000);
  });

  it('refuses bays taller than the lattice', () => {
    const p = { ...lattice(8, 'X'), height: 30 };
    expect(() => build('lattice', p)).toThrow(/^geometry: /);
  });

  it('uses the assembly material when it names one', () => {
    expect(only(build('lattice', lattice(2, 'Z'), { material: 'steel-blue' }).out()).material).toBe(
      'steel-blue',
    );
  });
});

describe('frame', () => {
  const portal: AssemblyParams<'frame'> = {
    kind: 'portal',
    base: [0, 0, 0],
    span: 6,
    height: 4,
    yawDeg: 0,
    bays: 1,
    braced: false,
    member: 0.3,
  };

  it('portal is two columns and a beam, braced adds two knee braces', () => {
    const plain = only(build('frame', portal).out());
    expectSolid(plain);
    expect(countComponents(plain)).toBe(3);
    const braced = only(build('frame', { ...portal, braced: true }).out());
    expectSolid(braced);
    expect(countComponents(braced)).toBe(5);
  });

  it('portal spans along its yaw and stands its height', () => {
    const b = bounds(only(build('frame', portal).out()));
    expect(b.min[0]).toBeCloseTo(-3.15, 9);
    expect(b.max[0]).toBeCloseTo(3.15, 9);
    expect(b.min[1]).toBeCloseTo(0, 9);
    expect(b.max[1]).toBeCloseTo(4, 9);
    expect(b.max[2]).toBeCloseTo(0.15, 9);
    const turned = bounds(only(build('frame', { ...portal, yawDeg: 90 }).out()));
    expect(turned.min[2]).toBeCloseTo(-3.15, 9);
    expect(turned.max[2]).toBeCloseTo(3.15, 9);
    expect(turned.max[0]).toBeCloseTo(0.15, 9);
  });

  it('multi-bay portal adds a column per bay', () => {
    expect(countComponents(only(build('frame', { ...portal, bays: 3 }).out()))).toBe(4 + 1);
    expect(countComponents(only(build('frame', { ...portal, bays: 3, braced: true }).out()))).toBe(
      4 + 1 + 6,
    );
  });

  it('rack has columns, a beam at each of two tiers and a diagonal per braced bay', () => {
    const rack = { ...portal, kind: 'rack' as const, bays: 4 };
    const plain = only(build('frame', rack).out());
    expectSolid(plain);
    expect(countComponents(plain)).toBe(5 + 2);
    const braced = only(build('frame', { ...rack, braced: true }).out());
    expectSolid(braced);
    expect(countComponents(braced)).toBe(5 + 2 + 4);
  });
});

describe('cabinet', () => {
  const cab: AssemblyParams<'cabinet'> = { base: [2, 1, 3], size: [1.2, 2, 0.8], yawDeg: 0 };

  it('is a closed body with two door leaves split by a seam', () => {
    const p = only(build('cabinet', cab).out());
    expect(p.material).toBe('cabinet-grey');
    expectSolid(p);
    expect(countComponents(p)).toBe(3);
  });

  it('sits on its base with its size, doors just proud of the front', () => {
    const b = bounds(only(build('cabinet', cab).out()));
    expect(b.min[0]).toBeCloseTo(1.4, 9);
    expect(b.max[0]).toBeCloseTo(2.6, 9);
    expect(b.min[1]).toBeCloseTo(1, 9);
    expect(b.max[1]).toBeCloseTo(3, 9);
    expect(b.min[2]).toBeCloseTo(2.6, 9);
    expect(b.max[2]).toBeGreaterThan(3.4);
    expect(b.max[2]).toBeLessThan(3.42);
  });

  it('turns by its yaw', () => {
    const b = bounds(only(build('cabinet', { ...cab, yawDeg: 90 }).out()));
    expect(b.max[2] - b.min[2]).toBeCloseTo(1.2, 9);
    expect(b.max[0] - b.min[0]).toBeGreaterThan(0.8);
  });
});
