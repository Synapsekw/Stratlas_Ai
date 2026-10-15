import { describe, expect, it } from 'vitest';
import type { Prim, V3 } from '../geom';
import {
  bounds,
  boundaryLoops,
  closedAndWound,
  degenerateTriangles,
  must,
  normalsAgree,
  normalsUnit,
  vertexAt,
} from '../testGeom';
import { LINE_BUILDERS } from './lines';
import { build, countComponents, registerBuilders } from './testFixtures';

registerBuilders(LINE_BUILDERS);

function expectSolid(p: Prim): void {
  expect(closedAndWound(p)).toBe(true);
  expect(normalsAgree(p)).toBe(true);
  expect(normalsUnit(p)).toBe(true);
  expect(degenerateTriangles(p)).toBe(0);
  expect(boundaryLoops(p)).toEqual([]);
}

function expectBounds(b: { min: V3; max: V3 }, min: number[], max: number[], digits = 6): void {
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

const key = (v: V3) => v.map((x) => Math.round(x * 1e4)).join(',');

interface Piece {
  points: V3[];
  centroid: V3;
  min: V3;
  max: V3;
}

/** The connected pieces of a primitive (welded at 0.1 mm), with their vertices and bounds. */
function pieces(p: Prim): Piece[] {
  const n = p.positions.length / 3;
  const weld = new Map<string, number>();
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    parent[i] = r;
    return r;
  };
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < n; i++) {
    const k = key(vertexAt(p, i));
    const w = weld.get(k);
    if (w === undefined) weld.set(k, i);
    else join(w, i);
  }
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    join(p.indices[t] ?? 0, p.indices[t + 1] ?? 0);
    join(p.indices[t] ?? 0, p.indices[t + 2] ?? 0);
  }
  const groups = new Map<number, V3[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), vertexAt(p, i)]);
  }
  return [...groups.values()].map((points) => {
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    const sum: V3 = [0, 0, 0];
    for (const q of points)
      for (const k of [0, 1, 2] as const) {
        min[k] = Math.min(min[k], q[k]);
        max[k] = Math.max(max[k], q[k]);
        sum[k] += q[k];
      }
    const c: V3 = [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
    return { points, centroid: c, min, max };
  });
}

/** Triangles that repeat another triangle's three corners (in any order). */
function duplicateTriangles(p: Prim): number {
  const seen = new Set<string>();
  let dup = 0;
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    const k = [0, 1, 2]
      .map((j) => key(vertexAt(p, p.indices[t + j] ?? 0)))
      .sort()
      .join('|');
    if (seen.has(k)) dup++;
    seen.add(k);
  }
  return dup;
}

const near = (a: V3, b: V3, tol = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;

describe('duct', () => {
  const brief = {
    path: [
      [0, 2, 0],
      [10, 2, 0],
      [10, 2, 10],
    ] as V3[],
    section: { rect: [2, 1.5] as [number, number] },
    transition: { at: 1, to: { round: 0.9 } },
    flanges: true,
  };

  it('duct with a rect-to-round transition is closed and continuous', () => {
    const s = build('duct', brief);
    for (const p of s.out()) expect(closedAndWound(p)).toBe(true);
    const p = only(s.out());
    expect(p.material).toBe('steel-galv');
    expectSolid(p);
    expect(duplicateTriangles(p)).toBe(0);
    // rect duct, collar, transition, collar, round duct, and a flange at each end
    expect(countComponents(p)).toBe(7);
    expect(p.openings).toBeUndefined();
    // rect flanges stand 0.1 m proud, round ones 0.09 m; the rect collar reaches x 11.1
    expectBounds(bounds(p), [-0.0075, 1.01, -1.1], [11.1, 2.99, 10.0075]);
  });

  it('the transition starts on the rect duct section and ends round', () => {
    const ps = pieces(only(build('duct', brief).out()));
    // the rect duct leaves its bend heading +z, 2 m across x and 1.5 m high
    const rect = must(ps.find((q) => q.min[0] < 1 && q.max[0] > 5));
    const endZ = rect.max[2];
    expect(endZ).toBeCloseTo(1.53, 9); // bend tangent 1.5 plus the collar thickness
    const endRing = rect.points.filter((q) => Math.abs(q[2] - endZ) < 1e-9);
    expect(new Set(endRing.map((q) => q[0].toFixed(6)))).toEqual(
      new Set(['9.000000', '11.000000']),
    );
    expect(new Set(endRing.map((q) => q[1].toFixed(6)))).toEqual(new Set(['1.250000', '2.750000']));
    // the transition piece (2 m long, as wide as the rectangle) lies beyond the bend
    const transition = ps.filter(
      (q) =>
        q.min[0] > 8 &&
        Math.abs(q.min[0] - 9) < 1e-9 &&
        Math.abs(q.max[0] - 11) < 1e-9 &&
        Math.abs(q.max[2] - q.min[2] - 2) < 1e-9,
    );
    expect(transition).toHaveLength(1);
    const t = must(transition[0]);
    expect(t.min[2] - endZ).toBeGreaterThan(0); // inside the collar, not touching the duct
    expect(t.min[2] - endZ).toBeLessThan(0.015);
    // it starts on the same rectangle the rect duct ends on, not turned
    const nearEnd = t.points.filter((q) => Math.abs(q[2] - t.min[2]) < 1e-9);
    expect(Math.min(...nearEnd.map((q) => q[0]))).toBeCloseTo(9, 9);
    expect(Math.max(...nearEnd.map((q) => q[0]))).toBeCloseTo(11, 9);
    expect(Math.min(...nearEnd.map((q) => q[1]))).toBeCloseTo(1.25, 9);
    expect(Math.max(...nearEnd.map((q) => q[1]))).toBeCloseTo(2.75, 9);
    const farEnd = t.points.filter((q) => Math.abs(q[2] - t.max[2]) < 1e-9);
    expect(farEnd.length).toBeGreaterThan(16);
    for (const q of farEnd) {
      // the centre point of the end cap, or a point on the 0.9 m circle
      const r = Math.hypot(q[0] - 10, q[1] - 2);
      expect(r < 1e-9 || Math.abs(r - 0.9) < 1e-9).toBe(true);
    }
    // the round duct runs on to the end, 0.9 m radius
    const round = must(ps.find((q) => Math.abs(q.max[0] - 10.9) < 1e-9 && q.max[2] > 9));
    expect(round.min[0]).toBeCloseTo(9.1, 9);
    expect(round.max[2]).toBeCloseTo(10, 9);
  });

  it('a duct rising first keeps the transition square to the rect duct it leaves', () => {
    const p = only(
      build('duct', {
        path: [
          [0, 0, 0],
          [0, 5, 0],
          [6, 5, 0],
        ],
        section: { rect: [1, 0.6] },
        transition: { at: 1, to: { round: 0.4 } },
      }).out(),
    );
    expectSolid(p);
    expect(countComponents(p)).toBe(5);
    const ps = pieces(p);
    const rect = must(ps.find((q) => q.min[1] < 1));
    const endX = rect.max[0];
    const end = rect.points.filter((q) => Math.abs(q[0] - endX) < 1e-9);
    const t = must(ps.find((q) => q.min[0] > endX && q.min[0] < endX + 0.015));
    const start = t.points.filter((q) => Math.abs(q[0] - t.min[0]) < 1e-9);
    for (const k of [1, 2] as const) {
      expect(Math.min(...start.map((q) => q[k]))).toBeCloseTo(Math.min(...end.map((q) => q[k])), 9);
      expect(Math.max(...start.map((q) => q[k]))).toBeCloseTo(Math.max(...end.map((q) => q[k])), 9);
    }
  });

  it('round to rect and rect to rect transitions are closed too', () => {
    const path: V3[] = [
      [0, 1, 0],
      [8, 1, 0],
    ];
    type Section = { rect: [number, number] } | { round: number };
    const cases: [Section, Section][] = [
      [{ round: 0.5 }, { rect: [1.2, 0.8] }],
      [{ rect: [1.2, 0.8] }, { rect: [0.6, 0.4] }],
      [{ round: 0.5 }, { round: 0.3 }],
    ];
    for (const [section, to] of cases) {
      const p = only(
        build('duct', { path, section, transition: { at: 0, to }, flanges: true }).out(),
      );
      expectSolid(p);
      expect(countComponents(p)).toBe(5);
    }
  });

  it('a plain rect duct with a bend is one closed piece', () => {
    const s = build('duct', {
      path: [
        [0, 5, 0],
        [6, 5, 0],
        [6, 9, 0],
      ],
      section: { rect: [0.6, 0.4] },
    });
    const p = only(s.out());
    expectSolid(p);
    expect(countComponents(p)).toBe(1);
    expect(duplicateTriangles(p)).toBe(0);
    // across z 0.6 m; the bend's outer wall at x 6.2
    expectBounds(bounds(p), [0, 4.8, -0.3], [6.2, 9, 0.3]);
  });

  it('a round duct with flanges has a flange at each end', () => {
    const p = only(
      build('duct', {
        path: [
          [0, 0, 0],
          [0, 8, 0],
        ],
        section: { round: 0.5 },
        flanges: true,
      }).out(),
    );
    expectSolid(p);
    expect(countComponents(p)).toBe(3);
    // flange faces stand a quarter of their thickness past the duct ends
    expectBounds(bounds(p), [-0.55, -0.0075, -0.55], [0.55, 8.0075, 0.55]);
  });

  it('a transition at the first point starts the duct with its collar', () => {
    const p = only(
      build('duct', {
        path: [
          [0, 0, 0],
          [5, 0, 0],
        ],
        section: { rect: [1, 0.5] },
        transition: { at: 0, to: { round: 0.3 } },
        flanges: true,
      }).out(),
    );
    expectSolid(p);
    expect(countComponents(p)).toBe(5); // collar, transition, collar, round duct, end flange
    expect(bounds(p).min[0]).toBeCloseTo(0, 9);
  });

  it('a transition at the last point or on a short leg is refused', () => {
    const at = (i: number, path: V3[]) => () =>
      build('duct', {
        path,
        section: { rect: [2, 1.5] },
        transition: { at: i, to: { round: 0.9 } },
      });
    expect(
      at(1, [
        [0, 0, 0],
        [5, 0, 0],
      ]),
    ).toThrow(/^geometry: /);
    expect(
      at(0, [
        [0, 0, 0],
        [0.4, 0, 0],
      ]),
    ).toThrow(/^geometry: /);
  });
});

describe('pipeRun', () => {
  const path: V3[] = [
    [0, 1, 0],
    [4, 1, 0],
    [4, 3, 0],
  ];

  it('pipe run is capped at both ends by default', () => {
    const s = build('pipeRun', { path, diameter: 0.2, bendRadius: 0.4 });
    expect(must(s.out()[0]).openings).toBeUndefined(); // capped by default
    const p = only(s.out());
    expect(p.material).toBe('steel-galv');
    expectSolid(p);
    expectBounds(bounds(p), [0, 0.9, -0.1], [4.1, 3, 0.1]);
  });

  it('a pipe run is one piece through its bends, without gaps or doubled faces', () => {
    const p = only(
      build('pipeRun', {
        path: [
          [0, 0, 0],
          [3, 0, 0],
          [3, 2, 0],
          [3, 2, 4],
          [6, 5, 4],
        ],
        diameter: 0.15,
      }).out(),
    );
    expectSolid(p);
    expect(countComponents(p)).toBe(1);
    expect(duplicateTriangles(p)).toBe(0);
  });

  it('flanges sit on the pipe at the listed points', () => {
    const p = only(
      build('pipeRun', { path, diameter: 0.2, bendRadius: 0.4, flanges: [0, 1, 2] }).out(),
    );
    expectSolid(p);
    expect(countComponents(p)).toBe(4);
    const centres = pieces(p)
      .filter((q) => q.max[2] > 0.15) // flanges are 0.16 in radius, the pipe 0.1
      .map((q) => q.centroid);
    expect(centres).toHaveLength(3);
    const tf = 0.025;
    const expected: V3[] = [
      [tf / 4, 1, 0], // its face a quarter thickness past the start
      [3.6, 1, 0], // where the bend starts (bend radius 0.4 on a right angle)
      [4, 3 - tf / 4, 0],
    ];
    for (const e of expected) expect(centres.some((c) => near(c, e))).toBe(true);
  });

  it('a flange index past the path is refused', () => {
    expect(() => build('pipeRun', { path, diameter: 0.2, flanges: [3] })).toThrow(/^geometry: /);
  });
});

describe('earthing', () => {
  it('earthing is a thin closed copper conductor along its path', () => {
    const p = only(
      build('earthing', {
        path: [
          [0, 0, 6],
          [0, 40, 6],
          [0, 40, 5],
        ],
        diameter: 0.01,
      }).out(),
    );
    expect(p.material).toBe('copper');
    expectSolid(p);
    expect(countComponents(p)).toBe(1);
    const b = bounds(p);
    expect(b.min[1]).toBeCloseTo(0, 9);
    expect(b.max[1]).toBeCloseTo(40.005, 6);
    expect(b.min[2]).toBeCloseTo(5, 9);
  });
});
