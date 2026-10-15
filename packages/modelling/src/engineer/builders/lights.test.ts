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
import { ctxFor } from './ctx';
import { LIGHT_BUILDERS, warningLightSurface } from './lights';
import { build, countComponents, model, registerBuilders, shaft } from './testFixtures';

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

  it.each(FIXTURES)(
    '%s: the lens is centred on centre, whichever way outward points',
    (fixture) => {
      const outs: [number, number, number][] = [
        [1, 0, 0],
        [0, 0, -2],
        [1, 0.3, 1],
        [0, 1, 0],
      ];
      for (const outward of outs) {
        const centre: [number, number, number] = [3, 40, -2];
        const lens = bounds(
          prim(build('warningLight', light(fixture, { centre, outward })).out(), 'lamp-lens-red'),
        );
        centre.forEach((c, k) => {
          expect(Math.abs((must(lens.min[k]) + must(lens.max[k])) / 2 - c)).toBeLessThan(1e-3);
        });
      }
    },
  );

  it('the bracket runs back along outward and reaches the shaft surface', () => {
    const host = shaft('shaft-1', [
      { y: 0, r: 6 },
      { y: 100, r: 6 },
    ]);
    const p = light('single', { centre: [6.4, 50, 0] });
    const surface = warningLightSurface(p);
    expect(surface[0]).toBeCloseTo(6, 9);
    expect(surface[2]).toBeCloseTo(0, 9);
    expect(Math.hypot(surface[0], surface[2])).toBeCloseTo(
      ctxFor(model([host])).radiusAt('shaft-1', surface[1]),
      9,
    );
    const out = build('warningLight', p, { with: [host] }).out();
    const mount = bounds(prim(out, 'steel-galv'));
    // starts 2 cm inside the shaft and ends under the housing
    expect(mount.min[0]).toBeCloseTo(6 - 0.02, 9);
    expect(mount.max[0]).toBeCloseTo(6.4, 9);
    const housing = bounds(prim(out, 'lamp-housing'));
    expect(housing.min[0]).toBeGreaterThan(6);
    expect(housing.min[1]).toBeCloseTo(mount.max[1], 9);
    for (const q of out) {
      const b = bounds(q);
      expect(b.max[0]).toBeLessThan(6.4 + 0.2 + 1e-9);
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
      light('single', { centre: [0, 50, -6.4], outward: [0, 0, -2] }),
    );
    expect(bounds(prim(turned.out(), 'steel-galv')).max[2]).toBeCloseTo(-6 + 0.02, 9);
    // a beacon on a shaft top at y 100: lens half height 0.08, housing 0.12, bracket 0.4
    const p = light('beacon', { centre: [0, 100.6, 0], outward: [0, 1, 0] });
    expect(warningLightSurface(p).map((v) => +v.toFixed(9) + 0)).toEqual([0, 100, 0]);
    const top = build('warningLight', p);
    for (const q of top.out()) {
      expectSolid(q);
      expect(bounds(q).min[1]).toBeGreaterThanOrEqual(100 - 0.02 - 1e-9);
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
