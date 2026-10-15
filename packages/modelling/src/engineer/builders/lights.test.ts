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
import { LIGHT_BUILDERS } from './lights';
import { build, countComponents, registerBuilders, shaft } from './testFixtures';

registerBuilders(LIGHT_BUILDERS);

function expectSolid(p: Prim): void {
  expect(closedAndWound(p)).toBe(true);
  expect(normalsAgree(p)).toBe(true);
  expect(normalsUnit(p)).toBe(true);
  expect(degenerateTriangles(p)).toBe(0);
  expect(boundaryLoops(p)).toEqual([]);
}

const prim = (prims: Prim[], material: string): Prim =>
  must(
    prims.find((p) => p.material === material),
    `primitive ${material}`,
  );

const light = (
  fixture: AssemblyParams<'warningLight'>['fixture'],
  o: Partial<AssemblyParams<'warningLight'>> = {},
): AssemblyParams<'warningLight'> => ({
  fixture,
  centre: [6, 50, 0],
  outward: [1, 0, 0],
  size: 0.4,
  ...o,
});

const FIXTURES = ['single', 'twin', 'canister', 'beacon'] as const;

describe('warningLight', () => {
  it('warning light has housing, lens and mount as three primitives; lens is emissive material', () => {
    const s = build('warningLight', {
      fixture: 'twin',
      centre: [6, 50, 0],
      outward: [1, 0, 0],
      size: 0.4,
    });
    expect(
      s
        .out()
        .map((p) => p.material)
        .sort(),
    ).toEqual(['lamp-housing', 'lamp-lens-red', 'steel-galv']);
  });

  it.each(FIXTURES)('%s: every primitive is closed and wound', (fixture) => {
    const out = build('warningLight', light(fixture)).out();
    expect(out.map((p) => p.material).sort()).toEqual([
      'lamp-housing',
      'lamp-lens-red',
      'steel-galv',
    ]);
    for (const p of out) expectSolid(p);
  });

  it('twin fixture has two lenses, single has one', () => {
    const lenses = (fixture: (typeof FIXTURES)[number]) =>
      countComponents(prim(build('warningLight', light(fixture)).out(), 'lamp-lens-red'));
    expect(lenses('twin')).toBe(2);
    expect(lenses('single')).toBe(1);
    expect(lenses('canister')).toBe(1);
    expect(lenses('beacon')).toBe(1);
  });

  it('the mount starts at the shaft surface and the lamp stands out along outward', () => {
    const out = build('warningLight', light('single'), {
      with: [
        shaft('shaft-1', [
          { y: 0, r: 8 },
          { y: 100, r: 4 },
        ]),
      ],
    }).out();
    const mount = bounds(prim(out, 'steel-galv'));
    expect(mount.min[0]).toBeLessThanOrEqual(6);
    expect(mount.min[0]).toBeGreaterThan(5.9);
    const housing = bounds(prim(out, 'lamp-housing'));
    expect(housing.min[0]).toBeGreaterThan(6);
    // nothing of the lamp sits inside the shaft or far beyond the fixture size
    for (const p of out) {
      const b = bounds(p);
      expect(b.max[0]).toBeLessThan(6 + 3 * 0.4);
      expect(Math.abs(b.max[2])).toBeLessThan(0.4);
    }
  });

  it('the lens sits on top of the housing, a canister lens is tall and a beacon a dome', () => {
    const lensOf = (fixture: (typeof FIXTURES)[number]) => {
      const out = build('warningLight', light(fixture)).out();
      return {
        lens: bounds(prim(out, 'lamp-lens-red')),
        housing: bounds(prim(out, 'lamp-housing')),
      };
    };
    const single = lensOf('single');
    expect(single.lens.min[1]).toBeGreaterThanOrEqual(single.housing.min[1]);
    const canister = lensOf('canister');
    const tall = canister.lens.max[1] - canister.lens.min[1];
    expect(tall).toBeGreaterThan(single.lens.max[1] - single.lens.min[1]);
    expect(tall).toBeGreaterThan(0.3);
    const beacon = lensOf('beacon');
    expect(beacon.lens.max[1]).toBeGreaterThan(beacon.housing.max[1]);
  });

  it('follows any outward direction, including straight up', () => {
    const turned = build(
      'warningLight',
      light('single', { centre: [0, 50, -6], outward: [0, 0, -2] }),
    );
    expect(bounds(prim(turned.out(), 'lamp-housing')).max[2]).toBeLessThan(-6);
    const top = build('warningLight', light('beacon', { centre: [0, 100, 0], outward: [0, 1, 0] }));
    for (const p of top.out()) {
      expectSolid(p);
      expect(bounds(p).min[1]).toBeGreaterThan(99.9);
    }
  });

  it('uses the assembly material for the housing only', () => {
    const out = build('warningLight', light('single'), { material: 'paint-white' }).out();
    expect(out.map((p) => p.material).sort()).toEqual([
      'lamp-lens-red',
      'paint-white',
      'steel-galv',
    ]);
  });

  it('refuses a zero outward direction', () => {
    expect(() => build('warningLight', light('single', { outward: [0, 0, 0] }))).toThrow(
      /^geometry: /,
    );
  });
});
