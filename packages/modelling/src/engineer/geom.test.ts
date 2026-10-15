import { describe, expect, it } from 'vitest';
import {
  MeshSink,
  SEGMENTS,
  bendStarts,
  ringPoints,
  sweepFrame,
  transport,
  triangulateWithHoles,
  type Prim,
  type V3,
} from './geom';
import {
  boundaryLoops,
  bounds,
  closedAndWound,
  degenerateTriangles,
  eulerCharacteristic,
  loopCentreRadius,
  must,
  normalsAgree,
  normalsUnit,
  solidOk,
  surfaceArea,
  vertexAt,
  volume,
} from './testGeom';

const only = (s: MeshSink): Prim => {
  const prims = s.out();
  expect(prims).toHaveLength(1);
  return must(prims[0], 'primitive');
};

/** Area of a regular n-gon of circumradius r. */
const ngon = (r: number, n: number) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);

const frustum = (s: MeshSink) => {
  s.frustumShell('c', {
    base: [0, 0, 0],
    axis: [0, 1, 0],
    profile: [
      { y: 0, r: 10 },
      { y: 50, r: 6 },
    ],
    capBottom: true,
    capTop: true,
  });
};

describe('geom kernel', () => {
  it('frustum shell closed with caps has the analytic volume', () => {
    const s = new MeshSink(SEGMENTS.detailed);
    frustum(s);
    const p = only(s);
    expect(closedAndWound(p)).toBe(true);
    expect(solidOk(p)).toBe(true);
    const exact = (Math.PI * 50 * (100 + 60 + 36)) / 3;
    expect(Math.abs(volume(p) - exact) / exact).toBeLessThan(0.01);
    const b = bounds(p);
    expect(b.min[1]).toBeCloseTo(0, 9);
    expect(b.max[1]).toBeCloseTo(50, 9);
    expect(b.max[0]).toBeCloseTo(10, 9);
  });

  it('annulus tube keeps its mouth open: two boundary loops at the declared radii', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.annulusTube('steel', {
      centre: [0, 0, 0],
      axis: [0, 1, 0],
      rOuter: 1.5,
      rInner: 1.3,
      y0: 0,
      y1: 10,
    });
    const p = only(s);
    // the tube itself is a closed annular solid (rim faces), the bore is open space
    expect(boundaryLoops(p)).toHaveLength(0);
    expect(p.openings).toEqual([{ centre: [0, 10, 0], normal: [0, 1, 0], r: 1.3 }]);
    expect(solidOk(p)).toBe(true);
    const n = SEGMENTS.standard(1.5);
    const exact = 10 * (ngon(1.5, n) - ngon(1.3, n));
    expect(volume(p) / exact).toBeCloseTo(1, 6);
    // nothing inside the bore: every vertex is at the inner or the outer radius
    for (let i = 0; i < p.positions.length / 3; i++) {
      const [x, , z] = vertexAt(p, i);
      expect(Math.hypot(x, z)).toBeGreaterThan(1.3 - 1e-9);
    }
  });

  it('annulus tube can declare the bottom too, along a tilted axis', () => {
    const s = new MeshSink(SEGMENTS.standard);
    const axis = [0.6, 0.8, 0] as V3;
    s.annulusTube('steel', {
      centre: [5, 2, 1],
      axis,
      rOuter: 1,
      rInner: 0.8,
      y0: -2,
      y1: 3,
      openings: 'both',
    });
    const p = only(s);
    expect(solidOk(p)).toBe(true);
    const o = must(p.openings, 'openings');
    expect(o).toHaveLength(2);
    expect(must(o[0]).centre.map((v) => +v.toFixed(9))).toEqual([6.8, 4.4, 1]);
    expect(must(o[1]).centre.map((v) => +v.toFixed(9))).toEqual([3.8, 0.4, 1]);
    expect(must(o[1]).normal.map((v) => +v.toFixed(9))).toEqual([-0.6, -0.8, 0]);
  });

  it('slab with holes leaves through-openings and stays closed', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.slab('deck', {
      y: 10,
      outline: { r: 6 },
      thickness: 0.3,
      holes: [
        { c: [2, 0], r: 1 },
        { c: [-2, 0], r: 1 },
      ],
    });
    const p = only(s);
    expect(closedAndWound(p)).toBe(true);
    expect(solidOk(p)).toBe(true);
    const exact = 0.3 * (ngon(6, SEGMENTS.standard(6)) - 2 * ngon(1, SEGMENTS.standard(1)));
    expect(volume(p) / exact).toBeCloseTo(1, 6);
    const b = bounds(p);
    expect(b.min[1]).toBeCloseTo(9.7, 9);
    expect(b.max[1]).toBeCloseTo(10, 9);
    expect(p.openings).toEqual([
      { centre: [2, 9.85, 0], normal: [0, 1, 0], r: 1 },
      { centre: [-2, 9.85, 0], normal: [0, 1, 0], r: 1 },
    ]);
    // genus 2: V - E + F = 2 - 2g = -2 on the welded mesh
    expect(eulerCharacteristic(p)).toBe(-2);
  });

  it('slab with a polygon outline (either winding) and a hole', () => {
    for (const outline of [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      [
        [0, 0],
        [0, 4],
        [4, 4],
        [4, 0],
      ],
    ] as [number, number][][]) {
      const s = new MeshSink(SEGMENTS.standard);
      s.slab('deck', { y: 1, outline, thickness: 0.5, holes: [{ c: [2, 2], r: 1 }] });
      const p = only(s);
      expect(solidOk(p)).toBe(true);
      const exact = 0.5 * (16 - ngon(1, SEGMENTS.standard(1)));
      expect(volume(p) / exact).toBeCloseTo(1, 6);
    }
  });

  it('triangulates a polygon with holes into exactly its area', () => {
    const outer = ringPoints2(0, 0, 5, 40);
    const holes = [ringPoints2(2, 0, 1, 12).reverse(), ringPoints2(-2, 1, 0.8, 10)];
    const tris = triangulateWithHoles(outer, holes);
    const pts = [outer, ...holes].flat();
    const area = tris.reduce((s, [a, b, c]) => {
      const [p, q, r] = [must(pts[a]), must(pts[b]), must(pts[c])];
      return s + Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2;
    }, 0);
    expect(area).toBeCloseTo(ngon(5, 40) - ngon(1, 12) - ngon(0.8, 10), 9);
    // a polygon with h holes and n vertices triangulates into n + 2h - 2 triangles
    expect(tris).toHaveLength(pts.length + 2 * holes.length - 2);
  });

  it('disc is a single flat face; its holes are open and declared', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.disc('plate', {
      centre: [0, 5, 0],
      normal: [0, 1, 0],
      r: 3,
      holes: [{ c: [1, 0], r: 0.5 }],
    });
    const p = only(s);
    expect(boundaryLoops(p)).toHaveLength(2);
    expect(normalsUnit(p)).toBe(true);
    expect(normalsAgree(p)).toBe(true);
    expect(degenerateTriangles(p)).toBe(0);
    for (let i = 1; i < p.normals.length; i += 3) expect(p.normals[i]).toBe(1);
    const exact = ngon(3, SEGMENTS.standard(3)) - ngon(0.5, SEGMENTS.standard(0.5));
    expect(surfaceArea(p)).toBeCloseTo(exact, 9);
    expect(p.openings).toEqual([{ centre: [1, 5, 0], normal: [0, 1, 0], r: 0.5 }]);
    const loops = boundaryLoops(p).map((l) => loopCentreRadius(p, l).r);
    expect(Math.min(...loops)).toBeCloseTo(0.5, 2);
    expect(Math.max(...loops)).toBeCloseTo(3, 2);
  });

  it('frustum without caps is an open tube with two boundary loops', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.frustumShell('c', {
      base: [0, 0, 0],
      axis: [0, 1, 0],
      profile: [
        { y: 0, r: 2 },
        { y: 4, r: 1 },
      ],
      capBottom: false,
      capTop: false,
    });
    const p = only(s);
    const loops = boundaryLoops(p).map((l) => loopCentreRadius(p, l));
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => +l.centre[1].toFixed(6)).sort()).toEqual([0, 4]);
    expect(normalsAgree(p)).toBe(true);
    expect(p.openings).toBeUndefined();
  });

  it('inward shell plus outer shell plus rim makes a closed hollow shaft', () => {
    const s = new MeshSink(SEGMENTS.standard);
    const n = SEGMENTS.standard(5);
    const outer = [
      { y: 0, r: 5 },
      { y: 50, r: 4 },
    ];
    const inner = outer.map((q) => ({ y: q.y, r: q.r - 0.4 }));
    const base: V3 = [0, 0, 0];
    const axis: V3 = [0, 1, 0];
    s.frustumShell('c', {
      base,
      axis,
      profile: outer,
      capBottom: false,
      capTop: false,
      segments: n,
    });
    s.frustumShell('c', {
      base,
      axis,
      profile: inner,
      capBottom: false,
      capTop: false,
      segments: n,
      inward: true,
    });
    for (const [y, rO, rI, sign] of [
      [50, 4, 3.6, 1],
      [0, 5, 4.6, -1],
    ] as const) {
      s.disc('c', {
        centre: [0, y, 0],
        normal: [0, sign, 0],
        r: rO,
        segments: n,
        holes: [{ c: [0, 0], r: rI, segments: n }],
        declareHoles: false,
      });
    }
    const p = only(s);
    expect(solidOk(p)).toBe(true);
    expect(p.openings).toBeUndefined();
  });

  it('polygonal frustum has flat sides and the polygon volume', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.frustumShell('steel', {
      base: [0, 0, 0],
      axis: [0, 1, 0],
      profile: [
        { y: 0, r: 1 },
        { y: 30, r: 0.5 },
      ],
      capBottom: true,
      capTop: true,
      sides: 12,
    });
    const p = only(s);
    expect(solidOk(p)).toBe(true);
    const [a0, a1] = [ngon(1, 12), ngon(0.5, 12)];
    expect(volume(p)).toBeCloseTo((30 / 3) * (a0 + a1 + Math.sqrt(a0 * a1)), 6);
    // 12 sides x 2 triangles + 2 caps x 10 triangles
    expect(s.triangles()).toBe(24 + 20);
  });

  it('a profile that ends at radius zero is a closed cone', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.frustumShell('c', {
      base: [1, 2, 3],
      axis: [0, 0, 1],
      profile: [
        { y: 0, r: 2 },
        { y: 3, r: 0 },
      ],
      capBottom: true,
      capTop: true,
    });
    const p = only(s);
    expect(solidOk(p)).toBe(true);
    expect(volume(p)).toBeCloseTo((ngon(2, SEGMENTS.standard(2)) * 3) / 3, 6);
  });

  it('box and beam have their volumes, turned and aligned as asked', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.box('a', { centre: [0, 0, 0], size: [6, 2, 3], yawDeg: 90 });
    const box = only(s);
    expect(solidOk(box)).toBe(true);
    expect(volume(box)).toBeCloseTo(36, 9);
    const b = bounds(box);
    expect(b.max[0] - b.min[0]).toBeCloseTo(3, 9);
    expect(b.max[2] - b.min[2]).toBeCloseTo(6, 9);
    expect(b.max[1] - b.min[1]).toBeCloseTo(2, 9);

    const t = new MeshSink(SEGMENTS.standard);
    t.box('a', { centre: [0, 0, 0], size: [1, 4, 1], up: [1, 0, 0] });
    const lying = bounds(only(t));
    expect(lying.max[0] - lying.min[0]).toBeCloseTo(4, 9);

    const u = new MeshSink(SEGMENTS.standard);
    const a: V3 = [1, 0, 0];
    const c: V3 = [4, 4, 0];
    u.beam('member', a, c, 0.1);
    const beam = only(u);
    expect(solidOk(beam)).toBe(true);
    expect(volume(beam)).toBeCloseTo(0.01 * 5, 9);
    const bb = bounds(beam);
    expect(bb.min[1]).toBeGreaterThan(-0.1);
    expect(bb.max[1]).toBeLessThan(4.1);
  });

  it('rod is a closed cylinder with caps and an open tube without', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.rod('rung', [0, 0, 0], [0, 0, 0.5], 0.02, true);
    const capped = only(s);
    expect(solidOk(capped)).toBe(true);
    expect(volume(capped)).toBeCloseTo(0.5 * ngon(0.02, SEGMENTS.standard(0.02)), 12);
    const t = new MeshSink(SEGMENTS.standard);
    t.rod('rung', [0, 0, 0], [2, 0, 0], 0.02, false);
    expect(boundaryLoops(only(t))).toHaveLength(2);
  });

  it('sweep with bends has unit normals and no degenerate triangles', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.sweep(
      'pipe',
      [
        [0, 0, 0],
        [5, 0, 0],
        [5, 5, 0],
        [5, 5, 5],
      ],
      0.2,
      { bendRadius: 0.6, capStart: true, capEnd: true },
    );
    const p = only(s);
    expect(normalsUnit(p)).toBe(true);
    expect(closedAndWound(p)).toBe(true);
    expect(normalsAgree(p)).toBe(true);
    expect(degenerateTriangles(p)).toBe(0);
    // centreline: 15 m less two corners, each trading 2 x 0.6 straight for a quarter arc of 0.6
    const length = 15 - 2 * (1.2 - (0.6 * Math.PI) / 2);
    const exact = length * ngon(0.2, SEGMENTS.standard(0.2));
    expect(Math.abs(volume(p) - exact) / exact).toBeLessThan(0.01);
    // the first corner is a quarter torus round (4.4, 0.6, 0): its vertices sit 0.2 off that arc
    let inBend = 0;
    for (let i = 0; i < p.positions.length / 3; i++) {
      const [x, y, z] = vertexAt(p, i);
      if (x <= 4.4 + 1e-9 || y >= 0.6 - 1e-9) continue;
      inBend++;
      expect(Math.hypot(Math.hypot(x - 4.4, y - 0.6) - 0.6, z)).toBeCloseTo(0.2, 9);
    }
    expect(inBend).toBeGreaterThan(0);
  });

  it('sweep with bend radius 0 mitres the corners and stays closed', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.sweep(
      'pipe',
      [
        [0, 1.5, 0],
        [10, 1.5, 0],
        [10, 1.5, -6],
        [10, 4, -6],
      ],
      0.15,
      { bendRadius: 0, capStart: true, capEnd: true },
    );
    const p = only(s);
    expect(solidOk(p)).toBe(true);
    const exact = 18.5 * ngon(0.15, SEGMENTS.standard(0.15));
    expect(Math.abs(volume(p) - exact) / exact).toBeLessThan(0.01);
  });

  it('uncapped sweep leaves both ends open; an explicit opening is recorded', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.sweep(
      'pipe',
      [
        [0, 1, 0],
        [4, 1, 0],
        [4, 3, 0],
      ],
      0.1,
      { capStart: false, capEnd: false },
    );
    s.opening('pipe', { centre: [4, 3, 0], normal: [0, 1, 0], r: 0.1 });
    const p = only(s);
    const loops = boundaryLoops(p).map((l) => loopCentreRadius(p, l));
    expect(loops).toHaveLength(2);
    for (const l of loops) expect(l.r).toBeCloseTo(0.1, 2);
    expect(p.openings).toEqual([{ centre: [4, 3, 0], normal: [0, 1, 0], r: 0.1 }]);
  });

  it('rect sweep keeps its section and closes with caps', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.rectSweep(
      'duct',
      [
        [0, 0, 0],
        [0, 0, 8],
      ],
      0.6,
      0.4,
      true,
    );
    const straight = only(s);
    expect(solidOk(straight)).toBe(true);
    expect(volume(straight)).toBeCloseTo(0.6 * 0.4 * 8, 9);
    const b = bounds(straight);
    // the height runs up: w across, h vertical
    expect(b.max[1] - b.min[1]).toBeCloseTo(0.4, 9);
    expect(b.max[0] - b.min[0]).toBeCloseTo(0.6, 9);

    const t = new MeshSink(SEGMENTS.standard);
    t.rectSweep(
      'duct',
      [
        [0, 0, 0],
        [6, 0, 0],
        [6, 6, 0],
        [6, 6, 6],
      ],
      0.5,
      0.3,
      true,
    );
    expect(solidOk(only(t))).toBe(true);
  });

  it('torus is closed with the Pappus volume; an arc of it is closed with end caps', () => {
    const s = new MeshSink(SEGMENTS.detailed);
    s.torus('rim', { centre: [0, 10, 0], axis: [0, 1, 0], R: 2, r: 0.1 });
    const p = only(s);
    expect(solidOk(p)).toBe(true);
    // Pappus over the polygons: section area times the polygonal centre path
    const [M, N] = [SEGMENTS.detailed(0.1), SEGMENTS.detailed(2.1)];
    const exact = ngon(0.1, M) * N * 2 * 2 * Math.sin(Math.PI / N);
    expect(Math.abs(volume(p) - exact) / exact).toBeLessThan(0.005);
    expect(Math.abs(volume(p) - 4 * Math.PI ** 2 * 0.01) / (4 * Math.PI ** 2 * 0.01)).toBeLessThan(
      0.02,
    );
    const b = bounds(p);
    expect(b.max[1]).toBeCloseTo(10.1, 6);
    expect(b.max[0]).toBeCloseTo(2.1, 6);

    const t = new MeshSink(SEGMENTS.detailed);
    t.torus('hoop', { centre: [0, 0, 0], axis: [0, 1, 0], R: 0.7, r: 0.02, arcDeg: 180 });
    const arc = only(t);
    expect(solidOk(arc)).toBe(true);
    const n = Math.ceil(SEGMENTS.detailed(0.72) / 2);
    const half = ngon(0.02, SEGMENTS.detailed(0.02)) * n * 2 * 0.7 * Math.sin(Math.PI / (2 * n));
    // coarse (12 steps): the faceted wedges fall a little short of section x chord
    expect(Math.abs(volume(arc) - half) / half).toBeLessThan(0.015);
    // the half hoop spans x from -0.72 to 0.72 and stays on the +z side
    const hb = bounds(arc);
    expect(hb.min[2]).toBeGreaterThan(-0.021);
    expect(hb.max[0]).toBeCloseTo(0.72, 6);
  });

  it('loft joins two rings of equal count with outward normals', () => {
    const s = new MeshSink(SEGMENTS.standard);
    const square = ringPoints([0, 0, 0], [0, 1, 0], Math.SQRT2, 4, Math.PI / 4);
    const a: V3[] = [];
    for (let i = 0; i < 4; i++) {
      const p = must(square[i]);
      const q = must(square[(i + 1) % 4]);
      for (let k = 0; k < 4; k++) {
        const f = k / 4;
        a.push([p[0] + (q[0] - p[0]) * f, 0, p[2] + (q[2] - p[2]) * f]);
      }
    }
    const b = ringPoints([0, 2, 0], [0, 1, 0], 0.8, 16, Math.PI / 4);
    s.loft('duct', a, b);
    const p = only(s);
    expect(boundaryLoops(p)).toHaveLength(2);
    expect(normalsUnit(p)).toBe(true);
    expect(normalsAgree(p)).toBe(true);
    expect(degenerateTriangles(p)).toBe(0);
    for (let i = 0; i < p.positions.length / 3; i++) {
      const [x, , z] = vertexAt(p, i);
      expect(x * (p.normals[3 * i] ?? 0) + z * (p.normals[3 * i + 2] ?? 0)).toBeGreaterThan(0);
    }
    expect(() => {
      s.loft('duct', a, b.slice(1));
    }).toThrow();
  });

  it('keeps one primitive per material, in first-use order', () => {
    const s = new MeshSink(SEGMENTS.standard);
    s.box('steel', { centre: [0, 0, 0], size: [1, 1, 1] });
    s.box('paint', { centre: [3, 0, 0], size: [1, 1, 1] });
    s.box('steel', { centre: [6, 0, 0], size: [1, 1, 1] });
    const prims = s.out();
    expect(prims.map((p) => p.material)).toEqual(['steel', 'paint']);
    expect(volume(must(prims[0]))).toBeCloseTo(2, 9);
    expect(s.triangles()).toBe(36);
    expect(s.prim('steel')).toBe(prims[0]);
  });

  it('fast detail uses fewer triangles than detailed', () => {
    const a = new MeshSink(SEGMENTS.fast);
    const b = new MeshSink(SEGMENTS.detailed);
    frustum(a);
    frustum(b);
    expect(a.triangles()).toBeLessThan(b.triangles());
  });

  it('segment counts follow the chord length within each detail range', () => {
    expect(SEGMENTS.fast(10)).toBe(48);
    expect(SEGMENTS.fast(0.01)).toBe(12);
    expect(SEGMENTS.standard(1)).toBe(16);
    expect(SEGMENTS.standard(3)).toBe(48);
    expect(SEGMENTS.standard(100)).toBe(96);
    expect(SEGMENTS.detailed(1)).toBe(32);
    expect(SEGMENTS.detailed(100)).toBe(160);
  });
});

describe('sweep frames and bends', () => {
  const std = () => new MeshSink(SEGMENTS.standard);
  const riser: V3[] = [
    [0, 0, 0],
    [0, 5, 0],
    [10, 5, 0],
  ];
  /** The corner positions of a rect sweep at the plane x = `x`. */
  const cornersAt = (p: Prim, x: number) => {
    const set = new Set<string>();
    for (let i = 0; i < p.positions.length / 3; i++) {
      const v = vertexAt(p, i);
      if (Math.abs(v[0] - x) < 1e-9) set.add(v.map((c) => c.toFixed(6)).join(','));
    }
    return [...set].sort();
  };

  it('sweepFrame gives the frame the sweep itself ends with', () => {
    const s = std();
    s.rectSweep('d', riser, 1, 0.6, true);
    const f = sweepFrame(riser, 1);
    const end = must(riser[2]);
    const at = (a: number, b: number): V3 => [
      end[0] + f.u[0] * a + f.v[0] * b,
      end[1] + f.u[1] * a + f.v[1] * b,
      end[2] + f.u[2] * a + f.v[2] * b,
    ];
    const expected = [-1, 1]
      .flatMap((a) => [-1, 1].map((b) => at(a * 0.5, b * 0.3)))
      .map((v) => v.map((c) => c.toFixed(6)).join(','))
      .sort();
    expect(cornersAt(only(s), 10)).toEqual(expected);
    expect(f.t).toEqual([1, 0, 0]);
  });

  it('startU turns the section; a sweep started on another frame continues it', () => {
    const s = std();
    s.rectSweep(
      'd',
      [
        [0, 0, 0],
        [0, 4, 0],
      ],
      1,
      0.6,
      true,
      { startU: [1, 0, 0] },
    );
    const b = bounds(only(s));
    expect(b.max[0]).toBeCloseTo(0.5, 9); // width along +x
    expect(b.max[2]).toBeCloseTo(0.3, 9);
    // a second rect sweep starting where the riser's frame leaves off has the same corners
    const f = sweepFrame(riser, 1);
    const a = std();
    a.rectSweep('d', riser, 1, 0.6, true);
    const c = std();
    c.rectSweep(
      'd',
      [
        [10, 5, 0],
        [12, 5, 0],
      ],
      1,
      0.6,
      true,
      { startU: f.u },
    );
    expect(cornersAt(only(c), 10)).toEqual(cornersAt(only(a), 10));
  });

  it('bendStarts gives each corner its tangent length, shrunk on short legs', () => {
    const r = bendStarts(riser, 0.4);
    expect(r[0]).toBe(0);
    expect(r[1]).toBeCloseTo(0.4, 12); // a right angle: R tan 45
    expect(r[2]).toBe(0);
    const short = bendStarts(
      [
        [0, 0, 0],
        [0.1, 0, 0],
        [0.1, 1, 0],
      ],
      0.4,
    );
    expect(short[1]).toBeCloseTo(0.1, 12);
    expect(bendStarts(riser, 0)).toEqual([0, 0, 0]);
  });

  it('an opening may carry its polygon outline', () => {
    const s = std();
    const outline: V3[] = [
      [1, 0, -0.5],
      [1, 0, 0.5],
      [-1, 0, 0.5],
      [-1, 0, -0.5],
    ];
    s.opening('o', { centre: [0, 0, 0], normal: [0, 2, 0], r: Math.hypot(1, 0.5), outline });
    expect(s.out()[0]?.openings).toEqual([
      { centre: [0, 0, 0], normal: [0, 1, 0], r: Math.hypot(1, 0.5), outline },
    ]);
  });

  it('transport turns a vector by the rotation between two directions', () => {
    const v = transport([0, 0, 1], [1, 0, 0], [0, 1, 0]);
    expect(v.map((x) => +x.toFixed(12))).toEqual([0, 0, 1]);
    const w = transport([0, 1, 0], [1, 0, 0], [0, 1, 0]);
    expect(w.map((x) => +x.toFixed(12) + 0)).toEqual([-1, 0, 0]);
  });
});

describe('geom kernel input checks and robustness', () => {
  const std = () => new MeshSink(SEGMENTS.standard);
  const square: [number, number][] = [
    [-5, -5],
    [5, -5],
    [5, 5],
    [-5, 5],
  ];

  it('closedAndWound rejects an inside-out piece sharing a primitive with a correct one', () => {
    const s = std();
    s.box('x', { centre: [0, 0, 0], size: [2, 2, 2] });
    const p = s.prim('x');
    const n0 = p.indices.length;
    s.box('x', { centre: [10, 0, 0], size: [1, 1, 1] });
    expect(closedAndWound(p)).toBe(true);
    for (let i = n0; i < p.indices.length; i += 3) {
      const t = must(p.indices[i + 1]);
      p.indices[i + 1] = must(p.indices[i + 2]);
      p.indices[i + 2] = t;
    }
    expect(volume(p)).toBeGreaterThan(0); // the total still looks fine
    expect(closedAndWound(p)).toBe(false);
  });

  it('a hole touching the outline is refused, not dropped', () => {
    const tangent = ringPoints2(4, 0, 1, 16);
    expect(() => triangulateWithHoles(square, [tangent])).toThrow(/hole/);
    expect(() => {
      std().slab('d', { y: 0, outline: square, thickness: 0.3, holes: [{ c: [4, 0], r: 1 }] });
    }).toThrow(/hole 1 touches or crosses the outline/);
    expect(() => {
      std().disc('d', {
        centre: [0, 0, 0],
        normal: [0, 1, 0],
        r: 3,
        holes: [{ c: [2.5, 0], r: 1 }],
      });
    }).toThrow(/outline/);
    expect(() => {
      std().slab('d', { y: 0, outline: square, thickness: 0.3, holes: [{ c: [7, 0], r: 1 }] });
    }).toThrow(/inside the outline/);
  });

  it('a thin concentric wall (1 percent) is accepted and closed; a crossing hole still throws', () => {
    const s = new MeshSink(() => 16);
    s.annulusTube('steel', {
      centre: [0, 0, 0],
      axis: [0, 1, 0],
      rOuter: 0.5,
      rInner: 0.495,
      y0: 0,
      y1: 10,
    });
    const p = only(s);
    expect(solidOk(p)).toBe(true);
    const exact = 10 * (ngon(0.5, 16) - ngon(0.495, 16));
    expect(volume(p) / exact).toBeCloseTo(1, 6);
    // the same thin ring as a deck hole and as a disc hole
    const t = new MeshSink(() => 16);
    t.slab('deck', { y: 0, outline: { r: 0.5 }, thickness: 0.1, holes: [{ c: [0, 0], r: 0.495 }] });
    expect(solidOk(only(t))).toBe(true);
    expect(() => {
      new MeshSink(() => 16).disc('d', {
        centre: [0, 0, 0],
        normal: [0, 1, 0],
        r: 0.5,
        holes: [{ c: [0, 0], r: 0.495 }],
      });
    }).not.toThrow();
    // off-centre by more than the wall: the hole crosses the outline
    expect(() => {
      new MeshSink(() => 16).slab('deck', {
        y: 0,
        outline: { r: 0.5 },
        thickness: 0.1,
        holes: [{ c: [0.01, 0], r: 0.495 }],
      });
    }).toThrow(/hole 1 touches or crosses the outline/);
    // larger than the outline polygon, though its centre is inside
    expect(() => {
      new MeshSink(() => 16).disc('d', {
        centre: [0, 0, 0],
        normal: [0, 1, 0],
        r: 0.5,
        holes: [{ c: [0, 0], r: 0.5 }],
      });
    }).toThrow(/hole 1 touches or crosses the outline/);
  });

  it('touching or overlapping holes are refused', () => {
    for (const c of [1, 0.5]) {
      expect(() => {
        std().slab('d', {
          y: 0,
          outline: { r: 6 },
          thickness: 0.3,
          holes: [
            { c: [c, 0], r: 1 },
            { c: [-c, 0], r: 1 },
          ],
        });
      }).toThrow(/holes 1 and 2 touch or overlap/);
    }
  });

  it('a polygon that cannot be triangulated is refused instead of fanned', () => {
    // a bow tie: self-intersecting
    const bow: [number, number][] = [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
    ];
    expect(() => triangulateWithHoles(bow, [])).toThrow(/simple polygon/);
  });

  it('triangulates the same at far-off coordinates (tolerances follow the outline size)', () => {
    const s = std();
    s.slab('d', {
      y: 0,
      outline: [
        [500000, 4000000],
        [500010, 4000000],
        [500010, 4000010],
        [500000, 4000010],
      ],
      thickness: 0.3,
      holes: [{ c: [500005, 4000005], r: 1 }],
    });
    const p = only(s);
    expect(closedAndWound(p)).toBe(true);
    expect(volume(p) / (0.3 * (100 - ngon(1, SEGMENTS.standard(1))))).toBeCloseTo(1, 4);
    const tiny = triangulateWithHoles(ringPoints2(0, 0, 1e-4, 24), [ringPoints2(0, 0, 0.5e-4, 12)]);
    expect(tiny).toHaveLength(24 + 12 + 2 - 2);
  });

  it('refuses non-finite, negative and inside-out inputs with a clear message', () => {
    const base: V3 = [0, 0, 0];
    const axis: V3 = [0, 1, 0];
    const cases: [string, () => void, RegExp][] = [
      [
        'NaN radius',
        () => {
          std().frustumShell('c', {
            base,
            axis,
            profile: [
              { y: 0, r: NaN },
              { y: 5, r: 1 },
            ],
            capBottom: true,
            capTop: true,
          });
        },
        /frustum profile/,
      ],
      [
        'negative radius',
        () => {
          std().frustumShell('c', {
            base,
            axis,
            profile: [
              { y: 0, r: -1 },
              { y: 5, r: 1 },
            ],
            capBottom: true,
            capTop: true,
          });
        },
        /not negative/,
      ],
      [
        'zero axis',
        () => {
          std().frustumShell('c', {
            base,
            axis: [0, 0, 0],
            profile: [
              { y: 0, r: 1 },
              { y: 5, r: 1 },
            ],
            capBottom: true,
            capTop: true,
          });
        },
        /frustum axis/,
      ],
      [
        'zero-height frustum',
        () => {
          std().frustumShell('c', {
            base,
            axis,
            profile: [
              { y: 0, r: 2 },
              { y: 0, r: 2 },
            ],
            capBottom: true,
            capTop: true,
          });
        },
        /needs some height/,
      ],
      [
        'inner above outer',
        () => {
          std().annulusTube('a', { centre: base, axis, rOuter: 1, rInner: 1.2, y0: 0, y1: 5 });
        },
        /outer radius must exceed the inner/,
      ],
      [
        'zero-height tube',
        () => {
          std().annulusTube('a', { centre: base, axis, rOuter: 1, rInner: 0.8, y0: 3, y1: 3 });
        },
        /y1 above y0/,
      ],
      [
        'zero thickness slab',
        () => {
          std().slab('d', { y: 0, outline: { r: 2 }, thickness: 0, holes: [] });
        },
        /slab thickness/,
      ],
      [
        'flat box',
        () => {
          std().box('b', { centre: base, size: [1, 0, 1] });
        },
        /box size/,
      ],
      [
        'zero-length beam',
        () => {
          std().beam('b', base, base, 0.1);
        },
        /beam ends must be apart/,
      ],
      [
        'NaN rod end',
        () => {
          std().rod('r', base, [NaN, 1, 0], 0.1, true);
        },
        /rod ends must be finite/,
      ],
      [
        'fat torus',
        () => {
          std().torus('t', { centre: base, axis, R: 0.1, r: 0.2 });
        },
        /torus radius must exceed/,
      ],
      [
        'zero disc',
        () => {
          std().disc('d', { centre: base, normal: axis, r: 0 });
        },
        /disc radius/,
      ],
      [
        'one-point sweep',
        () => {
          std().sweep('p', [base, base], 0.1, { capStart: true, capEnd: true });
        },
        /2 or more distinct points/,
      ],
      [
        'U-turn sweep',
        () => {
          std().sweep(
            'p',
            [
              [0, 0, 0],
              [5, 0, 0],
              [0, 0, 0],
            ],
            0.2,
            { capStart: true, capEnd: true },
          );
        },
        /doubles back/,
      ],
      [
        'zero-width rect sweep',
        () => {
          std().rectSweep('d', [base, [0, 0, 1]], 0, 0.3, true);
        },
        /rect sweep width/,
      ],
      [
        'bad opening',
        () => {
          std().opening('o', { centre: base, normal: axis, r: -1 });
        },
        /opening radius/,
      ],
      [
        'opening outline of two points',
        () => {
          std().opening('o', { centre: base, normal: axis, r: 1, outline: [base, [1, 0, 0]] });
        },
        /opening outline/,
      ],
    ];
    for (const [name, run, message] of cases) {
      expect(run, name).toThrow(message);
    }
  });

  it('a sharp but not doubled-back turn still sweeps closed', () => {
    const s = std();
    s.sweep(
      'p',
      [
        [0, 0, 0],
        [5, 0, 0],
        [0, 0, 0.5],
      ],
      0.2,
      { capStart: true, capEnd: true },
    );
    const p = only(s);
    expect(closedAndWound(p)).toBe(true);
    expect(normalsUnit(p)).toBe(true);
  });
});

/** Points on a circle in the plane, counter-clockwise. */
function ringPoints2(cx: number, cy: number, r: number, n: number): [number, number][] {
  return Array.from({ length: n }, (_, i): [number, number] => {
    const a = (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}
