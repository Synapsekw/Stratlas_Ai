import { describe, expect, it } from 'vitest';
import { add, cross, len, norm, scale, sub, type Prim, type V3 } from '../geom';
import {
  bounds,
  boundaryLoops,
  closedAndWound,
  componentVolumes,
  degenerateTriangles,
  must,
  normalsAgree,
  normalsUnit,
  vertexAt,
} from '../testGeom';
import { ACCESS_BUILDERS } from './access';
import { build, countComponents, registerBuilders, shaft } from './testFixtures';

registerBuilders(ACCESS_BUILDERS);

/** Closed, outward-wound pieces with unit normals and no sliver triangles. */
function expectSolid(p: Prim): void {
  expect(closedAndWound(p)).toBe(true);
  expect(normalsAgree(p)).toBe(true);
  expect(normalsUnit(p)).toBe(true);
  expect(degenerateTriangles(p)).toBe(0);
  expect(boundaryLoops(p)).toEqual([]);
}

function expectBounds(p: Prim, min: number[], max: number[], digits = 6): void {
  const b = bounds(p);
  b.min.forEach((v, k) => {
    expect(v).toBeCloseTo(must(min[k]), digits);
  });
  b.max.forEach((v, k) => {
    expect(v).toBeCloseTo(must(max[k]), digits);
  });
}

const only = (prims: Prim[]): Prim => {
  expect(prims).toHaveLength(1);
  return must(prims[0]);
};
const prim = (prims: Prim[], material: string): Prim =>
  must(
    prims.find((p) => p.material === material),
    `primitive ${material}`,
  );
const totalVolume = (p: Prim) => componentVolumes(p).reduce((s, v) => s + v, 0);

/** Smallest distance of the primitive's vertices from the line through `base` along `axis`. */
function nearestToAxis(p: Prim, base: V3, axis: V3): number {
  const a = norm(axis);
  let best = Infinity;
  for (let i = 0; i < p.positions.length / 3; i++)
    best = Math.min(best, len(cross(sub(vertexAt(p, i), base), a)));
  return best;
}

const TILT = (5 * Math.PI) / 180;
/** A straight 5 m radius shaft at `base`, 60 m long along `axis`. */
const pillar = (base: V3, axis: V3 = [0, 1, 0]) =>
  shaft(
    'shaft-1',
    [
      { y: 0, r: 5 },
      { y: 60, r: 5 },
    ],
    { base, axis },
  );

describe('ringPlatform', () => {
  it('a full ring is one closed annular slab of grating at its level', () => {
    const s = build('ringPlatform', { y: 40, rInner: 6, rOuter: 7.5, thickness: 0.1 });
    const p = only(s.out());
    expect(p.material).toBe('grating');
    expectSolid(p);
    expect(countComponents(p)).toBe(1);
    expect(p.openings).toBeUndefined();
    expectBounds(p, [-7.5, 39.9, -7.5], [7.5, 40, 7.5]);
    const exact = Math.PI * (7.5 ** 2 - 6 ** 2) * 0.1;
    expect(Math.abs(totalVolume(p) - exact) / exact).toBeLessThan(0.01);
  });

  it('a partial ring covers only its arc and is still closed', () => {
    const s = build('ringPlatform', {
      y: 40,
      rInner: 6,
      rOuter: 7.5,
      thickness: 0.1,
      arcDeg: 90,
    });
    const p = only(s.out());
    expectSolid(p);
    expect(countComponents(p)).toBe(1);
    // the arc runs from +x towards +z
    expectBounds(p, [0, 39.9, 0], [7.5, 40, 7.5]);
    const exact = (Math.PI * (7.5 ** 2 - 6 ** 2) * 0.1) / 4;
    expect(Math.abs(totalVolume(p) - exact) / exact).toBeLessThan(0.01);
  });

  it('a platform on a shaft rings its axis and refuses to cut into it', () => {
    const on = { with: [pillar([20, 0, -10])] };
    const p = only(
      build(
        'ringPlatform',
        { y: 40, rInner: 5.2, rOuter: 6.5, thickness: 0.1, shaft: 'shaft-1' },
        on,
      ).out(),
    );
    expectSolid(p);
    expectBounds(p, [13.5, 39.9, -16.5], [26.5, 40, -3.5]);
    const part = only(
      build(
        'ringPlatform',
        { y: 40, rInner: 5.2, rOuter: 6.5, thickness: 0.1, arcDeg: 90, shaft: 'shaft-1' },
        on,
      ).out(),
    );
    expectSolid(part);
    expectBounds(part, [20, 39.9, -10], [26.5, 40, -3.5]);
    expect(() =>
      build(
        'ringPlatform',
        { y: 40, rInner: 4.9, rOuter: 6.5, thickness: 0.1, shaft: 'shaft-1' },
        on,
      ),
    ).toThrow(/^geometry: platform would cut into shaft "shaft-1"/);
  });

  it('a platform on a tilted shaft is centred where the axis crosses its level', () => {
    const axis: V3 = [Math.sin(TILT), Math.cos(TILT), 0];
    const on = { with: [pillar([0, 0, 0], axis)] };
    const p = only(
      build(
        'ringPlatform',
        { y: 40, rInner: 5.2, rOuter: 6.5, thickness: 0.1, shaft: 'shaft-1' },
        on,
      ).out(),
    );
    expectSolid(p);
    const cx = 40 * Math.tan(TILT);
    expectBounds(p, [cx - 6.5, 39.9, -6.5], [cx + 6.5, 40, 6.5]);
    // the level section of a tilted shaft is wider than its radius: 5 / cos 5 = 5.019
    expect(() =>
      build(
        'ringPlatform',
        { y: 40, rInner: 5.01, rOuter: 6.5, thickness: 0.1, shaft: 'shaft-1' },
        on,
      ),
    ).toThrow(/^geometry: /);
  });

  it('uses the assembly material when it names one', () => {
    const s = build(
      'ringPlatform',
      { y: 10, rInner: 2, rOuter: 3, thickness: 0.1, arcDeg: 200 },
      { material: 'steel-galv' },
    );
    expect(s.out().map((p) => p.material)).toEqual(['steel-galv']);
    expectSolid(only(s.out()));
  });
});

describe('guardrail', () => {
  it('guardrail on a circle has posts at the requested spacing', () => {
    const s = build('guardrail', { path: { y: 100, r: 6 }, height: 1.1, posts: 1.5, rails: 2 });
    const p = only(s.out());
    expect(p.material).toBe('steel-galv');
    // posts + two rail rings
    expect(countComponents(p)).toBe(Math.ceil((2 * Math.PI * 6) / 1.5) + 2);
    expectSolid(p);
    const b = bounds(p);
    expect(b.min[1]).toBeCloseTo(100, 6); // post feet
    expect(b.max[1]).toBeCloseTo(101.1 + 0.021, 6); // top rail tube over the post tops
    expect(b.max[0]).toBeCloseTo(6 + 0.024, 3);
  });

  it('an open polyline gets a post at every spacing and at both ends', () => {
    const s = build('guardrail', {
      path: [
        [0, 50, 0],
        [4, 50, 0],
        [4, 50, 3],
      ],
      height: 1,
      posts: 1.5,
      rails: 3,
    });
    const p = only(s.out());
    // legs of 4 and 3 m: 3 + 2 intervals, 6 posts; three rails
    expect(countComponents(p)).toBe(6 + 3);
    expectSolid(p);
    const b = bounds(p);
    expect(b.min[1]).toBeCloseTo(50, 6);
    expect(b.max[1]).toBeCloseTo(51 + 0.021, 3);
  });

  it('a closed polyline loops its rails round without a post at the repeated corner', () => {
    const square: [number, number, number][] = [
      [0, 20, 0],
      [4, 20, 0],
      [4, 20, 4],
      [0, 20, 4],
      [0, 20, 0],
    ];
    const s = build('guardrail', { path: square, height: 1.1, posts: 1.5, rails: 1 });
    const p = only(s.out());
    expect(countComponents(p)).toBe(4 * 3 + 1); // 3 intervals per 4 m side, one rail
    expectSolid(p);
    expectBounds(p, [-0.024, 20, -0.024], [4.024, 21.1 + 0.021, 4.024], 2);
  });

  it('a circular guardrail on a shaft rings its axis, clear of it', () => {
    const on = { with: [pillar([20, 0, -10])] };
    const p = only(
      build(
        'guardrail',
        { path: { y: 40, r: 6.4, shaft: 'shaft-1' }, height: 1.1, posts: 1.5, rails: 2 },
        on,
      ).out(),
    );
    expectSolid(p);
    expect(countComponents(p)).toBe(Math.ceil((2 * Math.PI * 6.4) / 1.5) + 2);
    const b = bounds(p);
    expect(b.max[0]).toBeCloseTo(26.424, 3);
    expect(b.min[1]).toBeCloseTo(40, 9);
    expect(nearestToAxis(p, [20, 0, -10], [0, 1, 0])).toBeGreaterThan(6.3);
    expect(() =>
      build(
        'guardrail',
        { path: { y: 40, r: 5, shaft: 'shaft-1' }, height: 1.1, posts: 1.5, rails: 2 },
        on,
      ),
    ).toThrow(/^geometry: guardrail would cut into shaft "shaft-1"/);
  });

  it('a closed loop starts its rails at a post on a leg that has one', () => {
    const rect: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 4],
      [0, 0, 4],
      [0, 0, 0],
    ];
    const p = only(build('guardrail', { path: rect, height: 1, posts: 1.5, rails: 1 }).out());
    expectSolid(p);
    expect(countComponents(p)).toBe(1 + 3 + 1 + 3 + 1);
    // the rail's end caps face along the 4 m leg (x 1), at its first post (z 4/3)
    const caps: V3[] = [];
    for (let i = 0; i < p.normals.length / 3; i++) {
      const v = vertexAt(p, i);
      // post sides facing z stand 24 mm off their post's z; a rail cap's vertices do not
      const offPost = Math.min(...[4 / 3, 8 / 3].map((z) => Math.abs(v[2] - z)));
      if (Math.abs(p.normals[3 * i + 2] ?? 0) > 0.999999 && offPost < 0.02) caps.push(v);
    }
    expect(caps.length).toBeGreaterThan(0);
    for (const v of caps) {
      expect(Math.abs(v[2] - 4 / 3)).toBeLessThan(0.001);
      expect(Math.abs(v[0] - 1)).toBeLessThan(0.022);
      expect(v[1]).toBeGreaterThan(0.97); // the rail, not a post
    }
    // posts reach the top of the rail, hiding its seam
    expect(bounds(p).max[1]).toBeCloseTo(1 + 0.021, 9);
  });

  it('a closed loop of legs shorter than the spacing seams its rails at a corner post', () => {
    const square: [number, number, number][] = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      [0, 0, 0],
    ];
    const p = only(build('guardrail', { path: square, height: 1, posts: 1.5, rails: 2 }).out());
    expectSolid(p);
    expect(countComponents(p)).toBe(4 + 2);
  });

  it('a path with a repeated point is refused', () => {
    expect(() =>
      build('guardrail', {
        path: [
          [0, 0, 0],
          [0, 0, 0],
          [1, 0, 0],
        ],
        height: 1,
        posts: 1,
        rails: 1,
      }),
    ).toThrow(/^geometry: /);
  });
});

describe('ladder', () => {
  it('ladder rungs match spacing and the cage is a separate primitive group', () => {
    const s = build('ladder', {
      bottom: [0, 0, 6],
      top: [0, 30, 6],
      width: 0.5,
      rungSpacing: 0.3,
      cage: true,
    });
    expect(
      s
        .out()
        .map((p) => p.material)
        .sort(),
    ).toEqual(['steel-galv', 'steel-galv-cage']);
    const ladder = prim(s.out(), 'steel-galv');
    const cage = prim(s.out(), 'steel-galv-cage');
    expectSolid(ladder);
    expectSolid(cage);
    const rungs = Math.ceil(30 / 0.3) - 1; // none at the bottom or the top
    expect(rungs).toBe(99);
    expect(countComponents(ladder)).toBe(2 + rungs);
    // hoops every 0.9 m from 2.2 m and one at the top, plus five vertical bars
    const hoops = Math.floor((30 - 2.2) / 0.9) + 1 + 1;
    expect(countComponents(cage)).toBe(hoops + 5);
    // stiles 0.5 m apart across x, on the shaft side of the cage
    expectBounds(ladder, [-0.275, 0, 5.975], [0.275, 30, 6.025], 6);
    const cb = bounds(cage);
    expect(cb.min[1]).toBeCloseTo(2.2 - 0.02, 6); // lowest hoop's tube
    expect(cb.max[1]).toBeLessThanOrEqual(30 + 0.02 + 1e-9);
    // the cage stands out from the shaft (away from the axis), not into it
    expect(cb.max[2]).toBeGreaterThan(6.5);
    expect(cb.min[2]).toBeGreaterThan(5.9);
  });

  it('a short ladder without a cage has only stiles and rungs', () => {
    const s = build('ladder', {
      bottom: [3, 10, 0],
      top: [3, 13, 0],
      width: 0.45,
      rungSpacing: 0.3,
    });
    const p = only(s.out());
    expectSolid(p);
    expect(countComponents(p)).toBe(2 + (Math.ceil(3 / 0.3) - 1));
    expectBounds(p, [2.975, 10, -0.25], [3.025, 13, 0.25], 6);
  });

  it('a ladder on an off-origin shaft faces away from that shaft', () => {
    const s = build(
      'ladder',
      { bottom: [5.15, 0, 50], top: [5.15, 30, 50], width: 0.5, rungSpacing: 0.3, cage: true },
      { with: [pillar([0, 0, 50])] },
    );
    for (const p of s.out()) expectSolid(p);
    // stile surfaces are 5.125 from the axis at the nearest; the cage stands further out
    expect(nearestToAxis(prim(s.out(), 'steel-galv'), [0, 0, 50], [0, 1, 0])).toBeGreaterThan(
      5.124,
    );
    expect(nearestToAxis(prim(s.out(), 'steel-galv-cage'), [0, 0, 50], [0, 1, 0])).toBeGreaterThan(
      5.1,
    );
    expect(bounds(prim(s.out(), 'steel-galv-cage')).max[0]).toBeGreaterThan(5.6);
  });

  it('a ladder up a tilted shaft stays outside it', () => {
    const axis: V3 = [Math.sin(TILT), Math.cos(TILT), 0];
    const out: V3 = [Math.cos(TILT), -Math.sin(TILT), 0];
    const bottom = scale(out, 5.15);
    const top = add(bottom, scale(axis, 30));
    const s = build(
      'ladder',
      { bottom, top, width: 0.5, rungSpacing: 0.3, cage: true },
      { with: [pillar([0, 0, 0], axis)] },
    );
    for (const p of s.out()) expectSolid(p);
    expect(nearestToAxis(prim(s.out(), 'steel-galv'), [0, 0, 0], axis)).toBeGreaterThan(5.124);
    expect(nearestToAxis(prim(s.out(), 'steel-galv-cage'), [0, 0, 0], axis)).toBeGreaterThan(5.1);
  });

  it('a ladder with more than 2000 rungs is refused', () => {
    expect(() =>
      build('ladder', { bottom: [0, 0, 5], top: [0, 900, 5], width: 0.5, rungSpacing: 0.3 }),
    ).toThrow(/^geometry: /);
  });
});

describe('hatch', () => {
  it('a closed hatch is a frame with a lid on it', () => {
    const s = build('hatch', { centre: [2, 30, -1], size: [0.8, 0.6] });
    const p = only(s.out());
    expectSolid(p);
    expect(countComponents(p)).toBe(2);
    expect(p.openings).toBeUndefined();
    // frame 5 cm wide and 5 cm high, 1 cm lid on top
    expectBounds(p, [1.55, 30, -1.35], [2.45, 30.06, -0.65]);
  });

  it('an open hatch stands its lid up on the hinge and declares the opening', () => {
    const s = build('hatch', { centre: [2, 30, -1], size: [0.8, 0.6], open: true });
    const p = only(s.out());
    expectSolid(p);
    expect(countComponents(p)).toBe(2);
    // lid 0.85 m long, now upright
    expect(bounds(p).max[1]).toBeCloseTo(30.05 + 0.85, 9);
    const openings = must(p.openings);
    expect(openings).toHaveLength(1);
    const o = must(openings[0]);
    expect(o.centre).toEqual([2, 30.05, -1]);
    expect(o.normal).toEqual([0, 1, 0]);
    expect(o.r).toBeCloseTo(Math.hypot(0.4, 0.3), 9);
    // the real rectangle of the opening, inside the frame
    expect(must(o.outline).map((q) => q.map((x) => +x.toFixed(9)))).toEqual([
      [2.4, 30.05, -1.3],
      [2.4, 30.05, -0.7],
      [1.6, 30.05, -0.7],
      [1.6, 30.05, -1.3],
    ]);
  });
});

describe('louvre', () => {
  it('louvre has the requested blades', () => {
    const s = build('louvre', {
      centre: [5, 20, 0],
      normal: [1, 0, 0],
      size: [1.2, 0.9],
      blades: 8,
    });
    const p = only(s.out());
    expectSolid(p);
    expect(countComponents(p)).toBe(8 + 1); // blades + the frame
    // a 10 cm deep frame facing +x, 1.2 m across z and 0.9 m high
    expectBounds(p, [4.95, 19.55, -0.6], [5.05, 20.45, 0.6]);
  });

  it('blades are tilted 40 degrees, shedding outwards', () => {
    const s = build('louvre', { centre: [0, 0, 0], normal: [0, 0, 1], size: [1, 1], blades: 5 });
    const p = only(s.out());
    // blade faces carry the blade normal: 40 degrees from the louvre normal
    const tilts = new Set<string>();
    for (let i = 0; i < p.normals.length / 3; i++) {
      const n = [p.normals[3 * i] ?? 0, p.normals[3 * i + 1] ?? 0, p.normals[3 * i + 2] ?? 0];
      if (Math.abs(n[0] ?? 0) > 1e-9) continue; // blade ends and frame sides
      const deg = (Math.acos(Math.abs(n[2] ?? 0)) * 180) / Math.PI;
      tilts.add(deg.toFixed(6));
    }
    expect([...tilts].sort()).toEqual(['0.000000', '40.000000', '50.000000', '90.000000']);
    // outward (+z) the blades go down: the lowest blade point (inside the frame) is on the outer face
    let lowest = { y: Infinity, z: 0 };
    for (let i = 0; i < p.positions.length / 3; i++) {
      const v = vertexAt(p, i);
      if (Math.abs(v[1]) < 0.449 && v[1] < lowest.y) lowest = { y: v[1], z: v[2] };
    }
    expect(lowest.y).toBeLessThan(-0.39); // the bottom blade
    expect(lowest.z).toBeGreaterThan(0);
  });

  it('an oblique louvre is still closed with one piece per blade', () => {
    const s = build('louvre', {
      centre: [1, 2, 3],
      normal: [1, 0.3, -1],
      size: [0.8, 0.6],
      blades: 4,
    });
    const p = only(s.out());
    expectSolid(p);
    expect(countComponents(p)).toBe(5);
  });

  it('blades run into the frame sides', () => {
    const p = only(
      build('louvre', { centre: [5, 20, 0], normal: [1, 0, 0], size: [1.2, 0.9], blades: 8 }).out(),
    );
    // the frame's sides are 0.55 to 0.6 from the middle; blade ends sit half way into them
    const ends = new Set<string>();
    for (let i = 0; i < p.positions.length / 3; i++) {
      const v = vertexAt(p, i);
      if (Math.abs(v[2]) > 0.551 && Math.abs(v[2]) < 0.599) ends.add(Math.abs(v[2]).toFixed(6));
    }
    expect([...ends]).toEqual(['0.575000']);
    expect(countComponents(p)).toBe(9);
  });

  it('more blades than fit are refused', () => {
    expect(() =>
      build('louvre', { centre: [0, 0, 0], normal: [1, 0, 0], size: [0.3, 0.1], blades: 40 }),
    ).toThrow(/^geometry: /);
  });
});
