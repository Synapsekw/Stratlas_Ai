import type { AssemblyParams } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { SEGMENTS, type Prim, type V3 } from '../geom';
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
import { TELECOM_BUILDERS } from './telecom';
import { build, countComponents, registerBuilders } from './testFixtures';

registerBuilders(TELECOM_BUILDERS);

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

/** Unit face normal and area of triangle `t` (index into `indices`). */
function face(p: Prim, t: number): { n: V3; area: number } {
  const a = vertexAt(p, must(p.indices[t]));
  const b = vertexAt(p, must(p.indices[t + 1]));
  const c = vertexAt(p, must(p.indices[t + 2]));
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3 = [
    must(u[1]) * must(v[2]) - must(u[2]) * must(v[1]),
    must(u[2]) * must(v[0]) - must(u[0]) * must(v[2]),
    must(u[0]) * must(v[1]) - must(u[1]) * must(v[0]),
  ];
  const l = Math.hypot(...n);
  return { n: [n[0] / l, n[1] / l, n[2] / l], area: l / 2 };
}

/** The normal of the flat face (triangles sharing a normal) with the largest total area. */
function faceNormalOfLargestArea(p: Prim): V3 {
  const groups = new Map<string, { n: V3; area: number }>();
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    const f = face(p, t);
    const key = f.n.map((x) => Math.round(x * 1e4)).join(',');
    const g = groups.get(key) ?? { n: f.n, area: 0 };
    g.area += f.area;
    groups.set(key, g);
  }
  const best = [...groups.values()].sort((a, b) => b.area - a.area);
  const [first, second] = best;
  // a clear winner, not a tie between the front and the back
  expect(must(first).area).toBeGreaterThan(must(second).area * 1.05);
  return must(first).n;
}

/** Distinct side normals (not caps) of a primitive, rounded. */
function sideNormals(p: Prim): number {
  const keys = new Set<string>();
  for (let i = 0; i < p.normals.length; i += 3) {
    const n = [must(p.normals[i]), must(p.normals[i + 1]), must(p.normals[i + 2])];
    if (Math.abs(must(n[1])) > 0.9) continue;
    keys.add(n.map((x) => Math.round(x * 1e3)).join(','));
  }
  return keys.size;
}

const round3 = (v: V3) => v.map((x) => +x.toFixed(3) + 0);

describe('monopole', () => {
  const pole = (sides: number): AssemblyParams<'monopole'> => ({
    base: [0, 0, 0],
    profile: [
      { y: 0, r: 0.8 },
      { y: 30, r: 0.4 },
    ],
    sides,
  });

  it('monopole with 12 sides is polygonal, 0 sides is round', () => {
    const flat = only(build('monopole', pole(12)).out());
    expectSolid(flat);
    expect(sideNormals(flat)).toBe(12);
    const round = only(build('monopole', pole(0)).out());
    expectSolid(round);
    expect(sideNormals(round)).toBe(SEGMENTS.standard(0.8));
    expect(sideNormals(round)).toBeGreaterThan(12);
  });

  it('follows its profile from its base', () => {
    const b = bounds(only(build('monopole', { ...pole(0), base: [5, 2, -1] }).out()));
    expect(b.min[1]).toBeCloseTo(2, 9);
    expect(b.max[1]).toBeCloseTo(32, 9);
    expect(b.max[0]).toBeCloseTo(5.8, 9);
    expect(b.min[0]).toBeCloseTo(4.2, 9);
    expect(only(build('monopole', pole(0)).out()).material).toBe('steel-galv');
  });
});

describe('antenna', () => {
  const panel = (azimuthDeg: number, tiltDeg = 0): AssemblyParams<'antenna'> => ({
    kind: 'panel',
    centre: [0, 30, 0],
    azimuthDeg,
    tiltDeg,
    size: [0.3, 1.4, 0.15],
  });

  it('panel antenna faces its azimuth (0 = north = -Z)', () => {
    const s = build('antenna', panel(90));
    const front = faceNormalOfLargestArea(must(s.out()[0]));
    expect(front.map((v) => +v.toFixed(3))).toEqual([1, 0, 0]); // east
    expect(round3(faceNormalOfLargestArea(only(build('antenna', panel(0)).out())))).toEqual([
      0, 0, -1,
    ]);
    expect(round3(faceNormalOfLargestArea(only(build('antenna', panel(180)).out())))).toEqual([
      0, 0, 1,
    ]);
    expect(round3(faceNormalOfLargestArea(only(build('antenna', panel(270)).out())))).toEqual([
      -1, 0, 0,
    ]);
  });

  it('a positive tilt turns the panel face down', () => {
    const n = faceNormalOfLargestArea(only(build('antenna', panel(0, 10)).out()));
    const t = (10 * Math.PI) / 180;
    expect(round3(n)).toEqual(round3([0, -Math.sin(t), -Math.cos(t)]));
  });

  it('panel is a closed solid of its size round its centre', () => {
    const p = only(build('antenna', panel(0)).out());
    expectSolid(p);
    const b = bounds(p);
    expect(b.max[0] - b.min[0]).toBeCloseTo(0.3, 9);
    expect(b.max[1] - b.min[1]).toBeCloseTo(1.4, 9);
    expect(b.max[2] - b.min[2]).toBeCloseTo(0.15, 9);
    expect((b.max[1] + b.min[1]) / 2).toBeCloseTo(30, 9);
  });

  it('dish is a shallow cone with a rim facing its azimuth', () => {
    const p = only(
      build('antenna', {
        kind: 'dish',
        centre: [0, 20, 0],
        azimuthDeg: 90,
        tiltDeg: 0,
        size: [1.2, 1.2, 0.4],
      }).out(),
    );
    expectSolid(p);
    expect(countComponents(p)).toBe(2);
    const b = bounds(p);
    expect(b.max[1] - b.min[1]).toBeGreaterThan(1.2);
    expect(b.max[1] - b.min[1]).toBeLessThan(1.3);
    expect(b.max[0] - b.min[0]).toBeLessThan(0.5);
    expect(round3(faceNormalOfLargestArea(p))).toEqual([1, 0, 0]);
  });

  it('rru is a small box and omni a vertical rod', () => {
    const rru = only(
      build('antenna', {
        kind: 'rru',
        centre: [1, 10, 1],
        azimuthDeg: 45,
        tiltDeg: 0,
        size: [0.3, 0.5, 0.2],
      }).out(),
    );
    expectSolid(rru);
    expect(rru.material).toBe('cabinet-grey');
    const omni = only(
      build('antenna', {
        kind: 'omni',
        centre: [0, 40, 0],
        azimuthDeg: 0,
        tiltDeg: 0,
        size: [0.06, 2, 0.06],
      }).out(),
    );
    expectSolid(omni);
    const b = bounds(omni);
    expect(b.min[1]).toBeCloseTo(39, 9);
    expect(b.max[1]).toBeCloseTo(41, 9);
    expect(b.max[0]).toBeCloseTo(0.03, 9);
  });
});

describe('antennaMount', () => {
  const mount = (
    kind: AssemblyParams<'antennaMount'>['kind'],
    azimuthDeg = 0,
  ): AssemblyParams<'antennaMount'> => ({
    kind,
    centre: [0, 30, 0],
    azimuthDeg,
    size: [2, 2.5, 0.8],
  });

  it('pipe mount is one vertical pipe', () => {
    const p = only(build('antennaMount', { ...mount('pipe'), size: [0.1, 3, 0.1] }).out());
    expectSolid(p);
    expect(p.material).toBe('steel-galv');
    expect(countComponents(p)).toBe(1);
    const b = bounds(p);
    expect(b.min[1]).toBeCloseTo(28.5, 9);
    expect(b.max[1]).toBeCloseTo(31.5, 9);
  });

  it('sector frame is three pipes, two face beams and two arms', () => {
    const p = only(build('antennaMount', mount('sector-frame')).out());
    expectSolid(p);
    expect(countComponents(p)).toBe(7);
    // spread across the azimuth (east-west for north) and reaching out north
    const b = bounds(p);
    expect(b.max[0] - b.min[0]).toBeGreaterThan(2);
    expect(b.min[2]).toBeLessThan(-0.4);
    expect(b.max[2]).toBeGreaterThan(0.39);
  });

  it('standoff is a pipe on two arms reaching out along its azimuth', () => {
    const p = only(build('antennaMount', { ...mount('standoff', 90), size: [0.1, 2, 1] }).out());
    expectSolid(p);
    expect(countComponents(p)).toBe(3);
    const b = bounds(p);
    expect(b.min[0]).toBeLessThan(-0.99);
    expect(b.max[0]).toBeLessThan(0.1);
    expect(b.max[0]).toBeGreaterThan(0.04);
  });
});
