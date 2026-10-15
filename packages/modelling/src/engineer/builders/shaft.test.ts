import { describe, expect, it } from 'vitest';
import type { Prim } from '../geom';
import {
  bounds,
  boundaryLoops,
  closedAndWound,
  degenerateTriangles,
  eulerCharacteristic,
  must,
  normalsAgree,
  normalsUnit,
} from '../testGeom';
import { ctxFor } from './ctx';
import {
  assembly,
  band,
  build,
  countComponents,
  flue,
  model,
  ringRadiiAt,
  shaft,
  sinkFor,
} from './testFixtures';

/** A closed, outward-wound solid with unit normals and no sliver triangles. */
function expectSolid(p: Prim): void {
  expect(closedAndWound(p)).toBe(true);
  expect(normalsAgree(p)).toBe(true);
  expect(normalsUnit(p)).toBe(true);
  expect(degenerateTriangles(p)).toBe(0);
  expect(boundaryLoops(p)).toEqual([]);
}

function expectBounds(p: Prim, min: number[], max: number[], tol = 1e-6): void {
  const b = bounds(p);
  b.min.forEach((v, k) => {
    expect(v).toBeCloseTo(must(min[k]), -Math.log10(tol));
  });
  b.max.forEach((v, k) => {
    expect(v).toBeCloseTo(must(max[k]), -Math.log10(tol));
  });
}

const prim = (prims: Prim[], material: string): Prim =>
  must(
    prims.find((p) => p.material === material),
    `primitive ${material}`,
  );

const taper = [
  { y: 0, r: 10 },
  { y: 60, r: 6 },
  { y: 100, r: 6 },
];

describe('shaft', () => {
  it('shaft follows its taper profile', () => {
    const m = model([shaft('shaft-1', taper)]);
    const s = sinkFor(m, 'shaft-1');
    const radii = ringRadiiAt(must(s.out()[0]), [0, 30, 60, 100]);
    expect(radii.map((r) => +r.toFixed(2))).toEqual([10, 8, 6, 6]);
  });

  it('a solid shaft is one closed solid within its profile, with no openings', () => {
    const prims = sinkFor(model([shaft('shaft-1', taper)]), 'shaft-1').out();
    expect(prims.map((p) => p.material)).toEqual(['concrete-grey']);
    const p = must(prims[0]);
    expectSolid(p);
    expectBounds(p, [-10, 0, -10], [10, 100, 10], 1e-3);
    expect(p.openings).toBeUndefined();
  });

  it('open-top hollow shaft leaves the top open and declares it', () => {
    const s = sinkFor(
      model([
        shaft(
          'shaft-1',
          [
            { y: 0, r: 5 },
            { y: 50, r: 4 },
          ],
          { wall: 0.4, openTop: true },
        ),
      ]),
      'shaft-1',
    );
    const openings = s.out().flatMap((p) => p.openings ?? []);
    expect(openings).toHaveLength(1);
    const o = must(openings[0]);
    expect(o.centre).toEqual([0, 50, 0]);
    expect(o.normal).toEqual([0, 1, 0]);
    expect(o.r).toBeCloseTo(3.6, 9);
    const p = must(s.out()[0]);
    expectSolid(p); // the wall is a closed solid; the bore is open space
    expectBounds(p, [-5, 0, -5], [5, 50, 5], 1e-2);
    // a hollow wall has one through-hole (the bore): a torus-like surface
    expect(eulerCharacteristic(p)).toBe(0);
  });

  it('a closed-top hollow shaft is a closed solid without openings', () => {
    const s = sinkFor(
      model([
        shaft(
          'shaft-1',
          [
            { y: 0, r: 5 },
            { y: 50, r: 4 },
          ],
          { wall: 0.4 },
        ),
      ]),
      'shaft-1',
    );
    const p = must(s.out()[0]);
    expectSolid(p);
    expect(p.openings).toBeUndefined();
    expectBounds(p, [-5, 0, -5], [5, 50, 5], 1e-2);
  });

  it('a wall as thick as the shaft is refused', () => {
    const m = model([
      shaft(
        'shaft-1',
        [
          { y: 0, r: 5 },
          { y: 50, r: 0.3 },
        ],
        { wall: 0.4, openTop: true },
      ),
    ]);
    expect(() => sinkFor(m, 'shaft-1')).toThrow(/^geometry: /);
  });

  it('joints are 1 cm proud rings at each spacing, in their own material', () => {
    const m = model([shaft('shaft-1', taper, { joints: { spacing: 10 } })]);
    const prims = sinkFor(m, 'shaft-1').out();
    expect(prims.map((p) => p.material).sort()).toEqual(['concrete-grey', 'joint']);
    const j = prim(prims, 'joint');
    expect(countComponents(j)).toBe(9); // 10, 20, ... 90; none at the base or the top
    expect(closedAndWound(j)).toBe(true);
    expect(normalsUnit(j)).toBe(true);
    expect(degenerateTriangles(j)).toBe(0);
    const r = ringRadiiAt(j, [30]);
    expect(must(r[0]) - ctxFor(m).radiusAt('shaft-1', 30)).toBeCloseTo(0.01, 9);
  });

  it('a shaft on a tilted axis is still a closed solid', () => {
    const m = model([shaft('shaft-1', taper, { base: [5, 2, -3], axis: [0.2, 1, 0] })]);
    const p = must(sinkFor(m, 'shaft-1').out()[0]);
    expectSolid(p);
    expect(bounds(p).min[1]).toBeLessThan(2);
  });

  it('uses the assembly material when it names one', () => {
    const a = assembly(
      'shaft',
      'shaft-1',
      { base: [0, 0, 0], profile: taper, openTop: false },
      { material: 'concrete-cream' },
    );
    expect(
      sinkFor(model([a]), 'shaft-1')
        .out()
        .map((p) => p.material),
    ).toEqual(['concrete-cream']);
  });
});

describe('ctx', () => {
  it('radiusAt interpolates the profile from the shaft base and clamps at the ends', () => {
    const c = ctxFor(model([shaft('shaft-1', taper, { base: [0, 10, 0] })]));
    expect(c.radiusAt('shaft-1', 40)).toBeCloseTo(8, 9);
    expect(c.radiusAt('shaft-1', 0)).toBe(10);
    expect(c.radiusAt('shaft-1', 500)).toBe(6);
    expect(() => c.radiusAt('shaft-9', 10)).toThrow(/no shaft/);
    expect(c.material(undefined, 'joint')).toBe('joint');
    expect(c.material('paint-red', 'joint')).toBe('paint-red');
  });
});

describe('flue', () => {
  const stack = () =>
    model([
      shaft('shaft-1', [
        { y: 0, r: 8 },
        { y: 100, r: 6 },
      ]),
      ...[1, 2, 3, 4].map((i) => flue(`flue-${String(i)}`, i)),
    ]);

  it('four flues are four separate assemblies, each open at the mouth', () => {
    const m = stack();
    for (const id of ['flue-1', 'flue-2', 'flue-3', 'flue-4']) {
      const prims = sinkFor(m, id).out();
      expect(prims.flatMap((p) => p.openings ?? []).length).toBeGreaterThanOrEqual(1);
      for (const p of prims) expect(closedAndWound(p)).toBe(true);
    }
  });

  it('the mouth opening sits at the flue centre, facing up, with the bore radius', () => {
    const m = stack();
    const f = must(m.assemblies.find((a) => a.id === 'flue-2'));
    if (f.kind !== 'flue') throw new Error('expected a flue');
    const p = must(sinkFor(m, 'flue-2').out()[0]);
    expect(p.material).toBe('stainless');
    expectSolid(p);
    const [o, ...more] = p.openings ?? [];
    expect(more).toEqual([]);
    expect(must(o).centre.map((v) => +v.toFixed(9))).toEqual(
      f.params.centre.map((v) => +v.toFixed(9)),
    );
    expect(must(o).normal).toEqual([0, 1, 0]);
    expect(must(o).r).toBe(0.9);
    const [cx, cy, cz] = f.params.centre;
    expectBounds(p, [cx - 1, cy - 8, cz - 1], [cx + 1, cy, cz + 1], 1e-3);
  });

  it('rim and flanges are extra closed rings and leave the mouth open', () => {
    const m = model([flue('flue-1', 1, 4, { rim: true, flange: true })]);
    const p = must(sinkFor(m, 'flue-1').out()[0]);
    expect(closedAndWound(p)).toBe(true);
    expect(normalsUnit(p)).toBe(true);
    expect(degenerateTriangles(p)).toBe(0);
    expect(countComponents(p)).toBe(4); // tube, rim, two flanges
    expect(p.openings).toHaveLength(1);
  });
});

describe('band', () => {
  it('band wraps the shaft between y0 and y1 slightly proud of it', () => {
    const m = model([
      shaft('shaft-1', [
        { y: 0, r: 8 },
        { y: 100, r: 6 },
      ]),
      band('band-1', 'shaft-1', 40, 45),
    ]);
    const p = must(sinkFor(m, 'band-1').out()[0]);
    const r = must(ringRadiiAt(p, [42])[0]);
    const shaftR = ctxFor(m).radiusAt('shaft-1', 42);
    expect(r).toBeGreaterThan(shaftR);
    expect(r - shaftR).toBeLessThan(0.05);
    expect(p.material).toBe('paint-red');
    expectSolid(p);
    expect(bounds(p).min[1]).toBeCloseTo(40, 9);
    expect(bounds(p).max[1]).toBeCloseTo(45, 9);
  });

  it('a band across a change of taper follows the profile', () => {
    const m = model([shaft('shaft-1', taper), band('band-1', 'shaft-1', 55, 65)]);
    const p = must(sinkFor(m, 'band-1').out()[0]);
    expectSolid(p);
    expect(must(ringRadiiAt(p, [60])[0])).toBeCloseTo(6.01, 6);
    expect(must(ringRadiiAt(p, [65])[0])).toBeCloseTo(6.01, 6);
  });
});

describe('deck and base', () => {
  it('deck openings line up with flue centres', () => {
    const flues = [1, 2, 3, 4].map((i) => flue(`flue-${String(i)}`, i));
    const s = build('deck', {
      y: 100,
      outline: { r: 6 },
      thickness: 0.3,
      openings: flues.map((f) => ({ centre: [f.params.centre[0], f.params.centre[2]], r: 1 })),
    });
    const p = must(s.out()[0]);
    expectSolid(p);
    expect(eulerCharacteristic(p)).toBe(2 - 2 * 4); // four through-holes
    const openings = p.openings ?? [];
    expect(openings).toHaveLength(4);
    flues.forEach((f, i) => {
      const o = must(openings[i]);
      expect(o.centre[0]).toBeCloseTo(f.params.centre[0], 9);
      expect(o.centre[2]).toBeCloseTo(f.params.centre[2], 9);
      expect(o.r).toBe(1);
    });
    expectBounds(p, [-6, 99.7, -6], [6, 100, 6], 1e-2);
  });

  it('a deck with a polygon outline is a closed slab', () => {
    const p = must(
      build('deck', {
        y: 10,
        outline: [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
        ],
        thickness: 0.2,
        openings: [],
      }).out()[0],
    );
    expectSolid(p);
    expectBounds(p, [-2, 9.8, -2], [2, 10, 2]);
    expect(p.openings).toBeUndefined();
  });

  it('base rises height above y', () => {
    const p = must(build('base', { outline: { r: 9 }, y: -1, height: 1.5 }).out()[0]);
    expect(p.material).toBe('concrete-grey');
    expectSolid(p);
    expectBounds(p, [-9, -1, -9], [9, 0.5, 9], 1e-3);
  });
});

describe('flare tip', () => {
  it('flare tip with windshield and pilots builds separate material primitives', () => {
    const s = build('flareTip', {
      base: [0, 80, 0],
      r: 0.6,
      height: 3,
      windshield: true,
      pilots: 3,
    });
    const prims = s.out();
    expect(prims.map((p) => p.material).sort()).toEqual(['refractory', 'stainless', 'steel-sheet']);
    const body = prim(prims, 'stainless');
    expect(closedAndWound(body)).toBe(true);
    expect(normalsUnit(body)).toBe(true);
    expect(degenerateTriangles(body)).toBe(0);
    expect(countComponents(body)).toBe(1 + 3); // tip and three pilots
    expect(body.openings).toHaveLength(1);
    expect(must(body.openings?.[0]).centre).toEqual([0, 83, 0]);
    const lining = prim(prims, 'refractory');
    expectSolid(lining);
    expect(lining.openings).toHaveLength(1);
    // the windshield is a single sheet (a doubleSided material): one boundary loop round it
    const shield = prim(prims, 'steel-sheet');
    expect(boundaryLoops(shield)).toHaveLength(1);
    expect(normalsAgree(shield)).toBe(true);
    expect(normalsUnit(shield)).toBe(true);
    expect(degenerateTriangles(shield)).toBe(0);
    for (const p of prims) {
      const b = bounds(p);
      expect(b.min[1]).toBeGreaterThanOrEqual(80 - 1e-9);
      expect(Math.max(-b.min[0], b.max[0], -b.min[2], b.max[2])).toBeLessThan(0.6 * 1.5);
    }
  });

  it('a plain flare tip has no windshield or pilots', () => {
    const prims = build('flareTip', { base: [0, 0, 0], r: 0.5, height: 2 }).out();
    expect(prims.map((p) => p.material).sort()).toEqual(['refractory', 'stainless']);
    expect(countComponents(prim(prims, 'stainless'))).toBe(1);
    expectBounds(prim(prims, 'stainless'), [-0.5, 0, -0.5], [0.5, 2, 0.5], 1e-3);
  });
});
