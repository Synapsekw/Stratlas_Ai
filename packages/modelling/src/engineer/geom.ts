/**
 * Geometry kernel for the engineering assembly builders (shafts, flues, platforms, ladders,
 * lattice towers, lights ...). A `MeshSink` collects the triangles of one component, one
 * primitive per material, with every triangle wound to agree with its vertex normals (outwards
 * for solids). Positions are absolute float64; `meshAssemblies` makes them anchor-relative.
 *
 * Conventions: Y is up. A circle around an axis starts on the axis's `u` direction (see
 * `basis`), so rings built around the same axis line with the same count weld vertex for vertex,
 * whichever way the axis points. Circular things default to `segmentsFor(r)` segments; pass
 * `segments` to make neighbouring rings agree.
 */

export type V3 = [number, number, number];
export type V2 = [number, number];

/** One material's triangles of a component. */
export interface Prim {
  material: string;
  positions: number[];
  normals: number[];
  indices: number[];
  /** Openings meant to stay open (flue mouths, deck holes); absent when there are none. */
  openings?: Opening[];
}

/**
 * A declared, intended opening: a circle of radius `r` at `centre`, facing `normal`; or, with
 * `outline`, that polygon (an open hatch), `r` then the radius of the circle round it.
 */
export interface Opening {
  centre: V3;
  normal: V3;
  r: number;
  outline?: V3[];
}

/** A circular hole in a flat face, centred at `c` in the face's own 2D coordinates. */
export interface Hole {
  c: V2;
  r: number;
  segments?: number;
}

/** Segments around a circle of radius `r`: chords of about `chord` metres, `min` to `max`. */
export function clampSeg(r: number, chord: number, min: number, max: number): number {
  if (!(r > 0)) return min;
  return Math.max(min, Math.min(max, Math.ceil((2 * Math.PI * r) / chord)));
}

/** Circle segment counts per detail level. */
export const SEGMENTS = {
  fast: (r: number) => clampSeg(r, 0.8, 12, 48),
  standard: (r: number) => clampSeg(r, 0.4, 16, 96),
  detailed: (r: number) => clampSeg(r, 0.2, 24, 160),
};

// ---------------------------------------------------------------------------------------------
// vectors

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
/** Unit vector along `a`; `fallback` (default +Y) for a zero vector. */
export const norm = (a: V3, fallback: V3 = [0, 1, 0]): V3 => {
  const l = len(a);
  return l > 1e-15 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
};
/** `-0` to `0`, so declared values compare cleanly. */
const clean = (a: V3): V3 => [a[0] + 0, a[1] + 0, a[2] + 0];

/**
 * Two unit vectors `u`, `v` across the axis `a`. `u` depends only on the axis line (the same for
 * `a` and `-a`); for +Y it is +X and `v` is +Z.
 */
export function basis(a: V3): [V3, V3] {
  const n = norm(a);
  const h: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = norm(sub(h, scale(n, dot(n, h))));
  return [u, cross(u, n)];
}

/** `n` points on a circle around `axis` through `centre`, starting at angle `phase` from `u`. */
export function ringPoints(centre: V3, axis: V3, r: number, n: number, phase = 0): V3[] {
  const [u, v] = basis(axis);
  return Array.from({ length: n }, (_, k) => {
    const t = phase + (2 * Math.PI * k) / n;
    return add(centre, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t))));
  });
}

function circle2(c: V2, r: number, n: number): V2[] {
  return Array.from({ length: n }, (_, k): V2 => {
    const t = (2 * Math.PI * k) / n;
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
  });
}

/** Rotates `x` by the smallest rotation that takes unit `t0` to unit `t1`. */
export function transport(x: V3, t0: V3, t1: V3): V3 {
  const k = cross(t0, t1);
  const s = len(k);
  const c = dot(t0, t1);
  if (s < 1e-12) return x;
  const kk = scale(k, 1 / s);
  return add(add(scale(x, c), scale(cross(kk, x), s)), scale(kk, dot(kk, x) * (1 - c)));
}

function nth<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`index ${String(i)} out of range`);
  return x;
}

// ---------------------------------------------------------------------------------------------
// sweep frames and bends, shared by the sweeps and by builders that join pieces to them

/** Unit directions of the legs of `path`. */
export const legDirs = (path: readonly V3[]): V3[] =>
  path.slice(1).map((q, i) => norm(sub(q, nth(path, i))));

/**
 * The section x direction a sweep starts with along unit `t0`: `startU` made square to `t0`,
 * else level and across the path (so a rectangle's height is as near up as it goes).
 */
export function sweepStartU(t0: V3, startU?: V3): V3 {
  if (startU) {
    const u = sub(startU, scale(t0, dot(startU, t0)));
    if (len(u) > 1e-9) return norm(u);
  }
  return Math.abs(t0[1]) < 0.999 ? norm(cross(t0, [0, 1, 0])) : norm(cross(t0, [0, 0, 1]));
}

/**
 * The section frame (`u` = section x, `v` = section y, `t` = path direction) of a sweep along
 * `path` on leg `leg`: the start frame carried round each corner by the smallest rotation, the
 * same whatever the bend radius. `path` must have distinct consecutive points.
 */
export function sweepFrame(path: readonly V3[], leg: number, startU?: V3): { u: V3; v: V3; t: V3 } {
  const dirs = legDirs(path);
  let t = nth(dirs, 0);
  let u = sweepStartU(t, startU);
  for (let i = 1; i <= leg; i++) {
    const next = nth(dirs, i);
    u = norm(transport(u, t, next));
    u = norm(sub(u, scale(next, dot(u, next))));
    t = next;
  }
  return { u, v: cross(u, t), t };
}

/**
 * How far back from each point of `path` a sweep with bend radius `r0` starts its bend: the
 * tangent length, shrunk where the legs are too short (a corner may use the whole of its last
 * leg, half of any other, and what the previous bend left of the leg before it); 0 at the ends,
 * where the path runs straight on, and for `r0` 0 (mitred corners).
 */
export function bendStarts(path: readonly V3[], r0: number): number[] {
  const dirs = legDirs(path);
  const lens = path.slice(1).map((q, i) => len(sub(q, nth(path, i))));
  const out = path.map(() => 0);
  let used = 0;
  for (let i = 1; i + 1 < path.length; i++) {
    const dIn = nth(dirs, i - 1);
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(dIn, nth(dirs, i)))));
    if (theta < 1e-6 || r0 <= 0) {
      used = 0;
      continue;
    }
    const availIn = nth(lens, i - 1) - used;
    const availOut = i + 2 === path.length ? nth(lens, i) : nth(lens, i) / 2;
    const t = Math.max(0, Math.min(r0 * Math.tan(theta / 2), availIn, availOut));
    used = t;
    out[i] = t;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// input checks: every primitive refuses values that would make a broken or inside-out mesh

function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`geometry: ${what}`);
}
const finite = (...xs: number[]) => xs.every((x) => Number.isFinite(x));
const finiteV = (...vs: readonly V3[]) => vs.every((v) => finite(...v));
const needDir = (v: V3, what: string) => {
  need(finiteV(v) && len(v) > 1e-12, `${what} must be a finite, non-zero direction`);
};
const needPos = (x: number, what: string) => {
  need(Number.isFinite(x) && x > 0, `${what} must be a finite number above zero`);
};
const needCount = (n: number | undefined, what: string) => {
  need(
    n === undefined || (Number.isInteger(n) && n >= 3),
    `${what} must be a whole number of 3 or more`,
  );
};

/** Distance from `p` to the segment `a`-`b`. */
function segDist(p: V2, a: V2, b: V2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Circular holes must sit inside the outline polygon with clearance and keep clear of each other:
 * a hole touching the edge or another hole cannot be meshed as a closed solid. A hole is tested
 * as the polygon actually built (`segments` points), against the outline polygon as built, so a
 * thin concentric wall (a 5 mm flue wall) passes while anything touching or crossing does not.
 */
function checkHoles(
  outline: readonly V2[],
  holes: readonly Hole[],
  segmentsFor: (r: number) => number,
): void {
  const o0 = nth(outline, 0);
  const size = Math.max(
    ...outline.map((q) => Math.max(Math.abs(q[0] - o0[0]), Math.abs(q[1] - o0[1]))),
  );
  const gap = 1e-9 * Math.max(size, 1);
  const edgesOf = (r: readonly V2[]) => r.map((q, k): [V2, V2] => [q, nth(r, (k + 1) % r.length)]);
  const outlineEdges = edgesOf(outline);
  holes.forEach((h, i) => {
    const name = `hole ${String(i + 1)}`;
    need(finite(h.c[0], h.c[1]), `${name} centre must be finite`);
    needPos(h.r, `${name} radius`);
    needCount(h.segments, `${name} segments`);
    need(insideRing(h.c, outline), `${name} must lie inside the outline`);
    const ring = circle2(h.c, h.r, h.segments ?? segmentsFor(h.r));
    const clear =
      ring.every(
        (q) => insideRing(q, outline) && outlineEdges.every(([a, b]) => segDist(q, a, b) > gap),
      ) &&
      outline.every(
        (q) => !insideRing(q, ring) && edgesOf(ring).every(([a, b]) => segDist(q, a, b) > gap),
      ) &&
      edgesOf(ring).every(([a, b]) => outlineEdges.every(([c, d]) => !crosses(a, b, c, d)));
    need(clear, `${name} touches or crosses the outline`);
    holes.slice(0, i).forEach((o, j) => {
      const d = Math.hypot(h.c[0] - o.c[0], h.c[1] - o.c[1]);
      need(d > h.r + o.r + gap, `holes ${String(j + 1)} and ${String(i + 1)} touch or overlap`);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// triangulation

const area2 = (ring: readonly V2[]): number => {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = nth(ring, i);
    const b = nth(ring, (i + 1) % ring.length);
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};
const crossZ = (a: V2, b: V2, c: V2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const same = (a: V2, b: V2) => Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;

/** Segments p1p2 and q1q2 cross at a point inside both. */
function crosses(p1: V2, p2: V2, q1: V2, q2: V2): boolean {
  const d1 = crossZ(q1, q2, p1);
  const d2 = crossZ(q1, q2, p2);
  const d3 = crossZ(p1, p2, q1);
  const d4 = crossZ(p1, p2, q2);
  return (
    ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) &&
    ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))
  );
}

function insideRing(p: V2, ring: readonly V2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = nth(ring, i);
    const b = nth(ring, j);
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Ear clipping of a simple polygon with holes (either winding), each hole bridged to the nearest
 * visible vertex first. Triangles index into `[...outer, ...holes.flat()]`, wound
 * counter-clockwise.
 */
export function triangulateWithHoles(
  outer: readonly V2[],
  holes: readonly (readonly V2[])[] = [],
): [number, number, number][] {
  need(outer.length >= 3 && holes.every((h) => h.length >= 3), 'rings need 3 or more points');
  const raw: V2[] = [...outer, ...holes.flat()];
  need(
    raw.every((q) => finite(q[0], q[1])),
    'ring points must be finite',
  );
  // work in the outline's bounding box scaled to 1, so tolerances hold at any size or offset
  const xs = outer.map((q) => q[0]);
  const ys = outer.map((q) => q[1]);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const size = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0);
  need(size > 0, 'the outline has no extent');
  const unit = (r: readonly V2[]) => r.map((q): V2 => [(q[0] - x0) / size, (q[1] - y0) / size]);
  const pts = unit(raw);
  const outerU = unit(outer);
  const holesU = holes.map(unit);
  const P = (i: number) => nth(pts, i);
  // every ring simple and no two rings crossing: ear clipping is only sound on those
  const allEdges: [V2, V2][] = [outerU, ...holesU].flatMap((r) =>
    r.map((q, k): [V2, V2] => [q, nth(r, (k + 1) % r.length)]),
  );
  for (let i = 0; i < allEdges.length; i++) {
    const [a, b] = nth(allEdges, i);
    for (let j = i + 1; j < allEdges.length; j++) {
      const [c, d] = nth(allEdges, j);
      need(!crosses(a, b, c, d), 'the outline or a hole is not a simple polygon');
    }
  }
  let poly = outer.map((_, i) => i);
  if (area2(outer) < 0) poly.reverse();
  const holeIdx: number[][] = [];
  let off = outer.length;
  for (const h of holes) {
    const ids = h.map((_, i) => off + i);
    if (area2(h) > 0) ids.reverse(); // holes run clockwise
    holeIdx.push(ids);
    off += h.length;
  }
  // bridge holes, rightmost first
  const maxX = (ids: number[]) => Math.max(...ids.map((i) => P(i)[0]));
  const order = [...holeIdx].sort((a, b) => maxX(b) - maxX(a));
  for (let h = 0; h < order.length; h++) {
    const ids = nth(order, h);
    const mPos = ids.reduce((best, i, k) => (P(i)[0] > P(nth(ids, best))[0] ? k : best), 0);
    const M = nth(ids, mPos);
    const pm = P(M);
    const edges: [V2, V2][] = [];
    const ringEdges = (r: readonly number[]) => {
      for (let k = 0; k < r.length; k++) edges.push([P(nth(r, k)), P(nth(r, (k + 1) % r.length))]);
    };
    ringEdges(poly);
    for (const other of order.slice(h)) ringEdges(other);
    const counts = new Map<number, number>();
    for (const i of poly) counts.set(i, (counts.get(i) ?? 0) + 1);
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const V = nth(poly, k);
      if ((counts.get(V) ?? 0) > 1) continue;
      const pv = P(V);
      const d = Math.hypot(pv[0] - pm[0], pv[1] - pm[1]);
      if (d >= bestD || d < 1e-12) continue;
      if (
        edges.some(
          ([a, b]) =>
            !same(a, pv) && !same(b, pv) && !same(a, pm) && !same(b, pm) && crosses(pm, pv, a, b),
        )
      )
        continue;
      const mid: V2 = [(pm[0] + pv[0]) / 2, (pm[1] + pv[1]) / 2];
      if (!insideRing(mid, outerU) || holesU.some((hr) => insideRing(mid, hr))) continue;
      best = k;
      bestD = d;
    }
    need(best >= 0, 'a hole touches the outline or another hole and cannot be bridged');
    const loop = [...ids.slice(mPos), ...ids.slice(0, mPos), M];
    const V = nth(poly, best);
    poly = [...poly.slice(0, best + 1), ...loop, V, ...poly.slice(best + 1)];
  }
  // ear clipping
  const out: [number, number, number][] = [];
  const idx = [...poly];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100_000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = nth(idx, (k + idx.length - 1) % idx.length);
      const i1 = nth(idx, k);
      const i2 = nth(idx, (k + 1) % idx.length);
      const [a, b, c] = [P(i0), P(i1), P(i2)];
      if (crossZ(a, b, c) <= 1e-14) continue;
      const blocked = idx.some((j) => {
        const q = P(j);
        if (same(q, a) || same(q, b) || same(q, c)) return false;
        return crossZ(a, b, q) >= -1e-14 && crossZ(b, c, q) >= -1e-14 && crossZ(c, a, q) >= -1e-14;
      });
      if (blocked) continue;
      out.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  need(idx.length === 3, 'the outline or a hole is not a simple polygon');
  const [i0, i1, i2] = [nth(idx, 0), nth(idx, 1), nth(idx, 2)];
  if (crossZ(P(i0), P(i1), P(i2)) > 1e-14) out.push([i0, i1, i2]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// sweep sections

interface Section {
  pts: V2[];
  nrm: V2[];
  /** Pairs of section points joined along the sweep (a side strip each). */
  strips: [number, number][];
  /** Section points of the end caps, in order around. */
  cap: number[];
  /** Radius that sets the default bend radius and the arc steps. */
  reach: number;
}

function circleSection(r: number, n: number): Section {
  const pts = circle2([0, 0], r, n);
  return {
    pts,
    nrm: pts.map((p): V2 => [p[0] / r, p[1] / r]),
    strips: pts.map((_, k): [number, number] => [k, (k + 1) % n]),
    cap: pts.map((_, k) => k),
    reach: r,
  };
}

function rectSection(w: number, h: number): Section {
  const c: V2[] = [
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
    [-w / 2, -h / 2],
  ];
  const faceN: V2[] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  const pts: V2[] = [];
  const nrm: V2[] = [];
  const strips: [number, number][] = [];
  for (let k = 0; k < 4; k++) {
    pts.push(nth(c, k), nth(c, (k + 1) % 4));
    nrm.push(nth(faceN, k), nth(faceN, k));
    strips.push([2 * k, 2 * k + 1]);
  }
  return { pts, nrm, strips, cap: [0, 2, 4, 6], reach: Math.max(w, h) / 2 };
}

interface Station {
  c: V3;
  tIn: V3;
  tOut: V3;
}

// ---------------------------------------------------------------------------------------------
// the sink

/** Collects one component's triangles, one primitive per material. */
export class MeshSink {
  private readonly prims = new Map<string, Prim>();

  constructor(readonly segmentsFor: (r: number) => number) {}

  /** The primitive of `material`, created on first use. */
  prim(material: string): Prim {
    let p = this.prims.get(material);
    if (!p) {
      p = { material, positions: [], normals: [], indices: [] };
      this.prims.set(material, p);
    }
    return p;
  }

  /** Declares an intended opening on the primitive of `material`. */
  opening(material: string, o: Opening): void {
    need(finiteV(o.centre), 'opening centre must be finite');
    needDir(o.normal, 'opening normal');
    needPos(o.r, 'opening radius');
    if (o.outline)
      need(
        o.outline.length >= 3 && finiteV(...o.outline),
        'opening outline needs 3 or more finite points',
      );
    const p = this.prim(material);
    const decl: Opening = { centre: clean(o.centre), normal: clean(norm(o.normal)), r: o.r };
    if (o.outline) decl.outline = o.outline.map(clean);
    (p.openings ??= []).push(decl);
  }

  /** Triangles so far, over every material. */
  triangles(): number {
    let n = 0;
    for (const p of this.prims.values()) n += p.indices.length / 3;
    return n;
  }

  /** The primitives with any triangles or openings, in first-use order. */
  out(): Prim[] {
    return [...this.prims.values()].filter((p) => p.indices.length > 0 || p.openings);
  }

  // -- low level, ported from the mesher's Builder ------------------------------------------

  /** A vertex with a unit normal; returns its index. */
  vertex(p: Prim, at: V3, n: V3): number {
    const u = norm(n);
    p.positions.push(at[0], at[1], at[2]);
    p.normals.push(u[0], u[1], u[2]);
    return p.positions.length / 3 - 1;
  }

  private at(p: Prim, i: number): V3 {
    return [p.positions[3 * i] ?? 0, p.positions[3 * i + 1] ?? 0, p.positions[3 * i + 2] ?? 0];
  }

  private nrm(p: Prim, i: number): V3 {
    return [p.normals[3 * i] ?? 0, p.normals[3 * i + 1] ?? 0, p.normals[3 * i + 2] ?? 0];
  }

  /** A triangle, flipped when its winding disagrees with its vertex normals; dropped when flat. */
  tri(p: Prim, a: number, b: number, c: number): void {
    const pa = this.at(p, a);
    const face = cross(sub(this.at(p, b), pa), sub(this.at(p, c), pa));
    if (dot(face, face) < 1e-24) return;
    const n = add(add(this.nrm(p, a), this.nrm(p, b)), this.nrm(p, c));
    if (dot(face, n) < 0) p.indices.push(a, c, b);
    else p.indices.push(a, b, c);
  }

  quad(p: Prim, a: number, b: number, c: number, d: number): void {
    this.tri(p, a, b, c);
    this.tri(p, a, c, d);
  }

  /** A flat convex polygon with one normal. */
  fan(p: Prim, points: readonly V3[], n: V3): void {
    const ids = points.map((q) => this.vertex(p, q, n));
    for (let i = 1; i + 1 < ids.length; i++) this.tri(p, nth(ids, 0), nth(ids, i), nth(ids, i + 1));
  }

  // -- primitives ----------------------------------------------------------------------------

  /**
   * A surface of revolution through `profile` (heights `y` along `axis` from `base`, radii `r`,
   * in rising `y`; equal `y` makes a flat step). Smooth sides, or `sides` flat faces for a
   * polygonal section. `inward` turns every normal in (the inside face of a hollow shaft).
   * Without caps the ends are open boundary loops.
   */
  frustumShell(
    m: string,
    o: {
      base: V3;
      axis: V3;
      profile: { y: number; r: number }[];
      capBottom: boolean;
      capTop: boolean;
      sides?: number;
      segments?: number;
      inward?: boolean;
    },
  ): void {
    need(finiteV(o.base), 'frustum base must be finite');
    needDir(o.axis, 'frustum axis');
    need(o.profile.length >= 2, 'frustum profile needs 2 or more points');
    need(
      o.profile.every((q) => finite(q.y, q.r) && q.r >= 0),
      'frustum profile heights must be finite and radii finite and not negative',
    );
    needCount(o.sides, 'frustum sides');
    needCount(o.segments, 'frustum segments');
    const prof = o.profile.map((q, i) => ({ ...q, i })).sort((a, b) => a.y - b.y || a.i - b.i);
    need(nth(prof, prof.length - 1).y - nth(prof, 0).y > 0, 'frustum profile needs some height');
    need(
      prof.some((q) => q.r > 0),
      'frustum profile needs a radius above zero',
    );
    const p = this.prim(m);
    const a = norm(o.axis);
    const [u, v] = basis(a);
    const flat = o.sides !== undefined;
    const n = Math.max(
      3,
      Math.round(o.sides ?? o.segments ?? this.segmentsFor(Math.max(...prof.map((q) => q.r)))),
    );
    const sign = o.inward ? -1 : 1;
    const dir = (t: number): V3 => add(scale(u, Math.cos(t)), scale(v, Math.sin(t)));
    const theta = (k: number) => (2 * Math.PI * k) / n;
    const point = (y: number, r: number, k: number): V3 =>
      add(add(o.base, scale(a, y)), scale(dir(theta(k)), r));
    const strip = (
      r0: number,
      r1: number,
      ids: (k: number) => [number, number, number, number],
    ) => {
      for (let k = 0; k < n; k++) {
        const [a0, b0, b1, a1] = ids(k);
        if (r1 <= 0) this.tri(p, a0, b0, a1);
        else if (r0 <= 0) this.tri(p, a0, b1, a1);
        else this.quad(p, a0, b0, b1, a1);
      }
    };
    for (let i = 0; i + 1 < prof.length; i++) {
      const q0 = nth(prof, i);
      const q1 = nth(prof, i + 1);
      const dy = q1.y - q0.y;
      const dr = q0.r - q1.r;
      if ((Math.abs(dy) < 1e-12 && Math.abs(dr) < 1e-12) || (q0.r <= 0 && q1.r <= 0)) continue;
      if (flat) {
        const apo = Math.cos(Math.PI / n);
        strip(q0.r, q1.r, (k) => {
          const nn = scale(
            add(scale(dir((theta(k) + theta(k + 1)) / 2), dy), scale(a, dr * apo)),
            sign,
          );
          return [
            this.vertex(p, point(q0.y, q0.r, k), nn),
            this.vertex(p, point(q0.y, q0.r, k + 1), nn),
            this.vertex(p, point(q1.y, q1.r, k + 1), nn),
            this.vertex(p, point(q1.y, q1.r, k), nn),
          ];
        });
      } else {
        const nAt = (k: number) => scale(add(scale(dir(theta(k)), dy), scale(a, dr)), sign);
        const r0 = Array.from({ length: n }, (_, k) =>
          this.vertex(p, point(q0.y, q0.r, k), nAt(k)),
        );
        const r1 = Array.from({ length: n }, (_, k) =>
          this.vertex(p, point(q1.y, q1.r, k), nAt(k)),
        );
        strip(q0.r, q1.r, (k) => {
          const j = (k + 1) % n;
          return [nth(r0, k), nth(r0, j), nth(r1, j), nth(r1, k)];
        });
      }
    }
    const cap = (q: { y: number; r: number }, up: number) => {
      if (q.r <= 0) return;
      this.fan(
        p,
        Array.from({ length: n }, (_, k) => point(q.y, q.r, k)),
        scale(a, up * sign),
      );
    };
    if (o.capBottom) cap(nth(prof, 0), -1);
    if (o.capTop) cap(nth(prof, prof.length - 1), 1);
  }

  /**
   * A thick-walled tube between `y0` and `y1` along `axis` from `centre`: outer wall, inner wall
   * facing the bore, and flat rims at both ends, so the wall is a closed solid and the bore is
   * open space. Declares the bore as an opening at the top (default), the bottom, both or none.
   */
  annulusTube(
    m: string,
    o: {
      centre: V3;
      axis: V3;
      rOuter: number;
      rInner: number;
      y0: number;
      y1: number;
      segments?: number;
      openings?: 'top' | 'bottom' | 'both' | 'none';
    },
  ): void {
    need(finiteV(o.centre), 'annulus tube centre must be finite');
    needDir(o.axis, 'annulus tube axis');
    needPos(o.rInner, 'annulus tube inner radius');
    need(
      Number.isFinite(o.rOuter) && o.rOuter > o.rInner,
      'annulus tube outer radius must exceed the inner',
    );
    need(finite(o.y0, o.y1) && o.y1 > o.y0, 'annulus tube needs y1 above y0');
    needCount(o.segments, 'annulus tube segments');
    const a = norm(o.axis);
    const n = o.segments ?? this.segmentsFor(o.rOuter);
    const shell = (r: number, inward: boolean) => {
      this.frustumShell(m, {
        base: o.centre,
        axis: a,
        profile: [
          { y: o.y0, r },
          { y: o.y1, r },
        ],
        capBottom: false,
        capTop: false,
        segments: n,
        inward,
      });
    };
    shell(o.rOuter, false);
    shell(o.rInner, true);
    const hole: Hole[] = [{ c: [0, 0], r: o.rInner, segments: n }];
    const top = add(o.centre, scale(a, o.y1));
    const bottom = add(o.centre, scale(a, o.y0));
    const opt = { r: o.rOuter, segments: n, holes: hole, declareHoles: false };
    this.disc(m, { centre: top, normal: a, ...opt });
    this.disc(m, { centre: bottom, normal: scale(a, -1), ...opt });
    const which = o.openings ?? 'top';
    if (which === 'top' || which === 'both')
      this.opening(m, { centre: top, normal: a, r: o.rInner });
    if (which === 'bottom' || which === 'both')
      this.opening(m, { centre: bottom, normal: scale(a, -1), r: o.rInner });
  }

  /**
   * A single-sided flat disc facing `normal`, with circular holes (centres in the disc's `u`,
   * `v` coordinates, see `basis`). The holes are declared as openings unless `declareHoles` is
   * false (a rim that closes a solid).
   */
  disc(
    m: string,
    o: {
      centre: V3;
      normal: V3;
      r: number;
      holes?: Hole[];
      segments?: number;
      declareHoles?: boolean;
    },
  ): void {
    need(finiteV(o.centre), 'disc centre must be finite');
    needDir(o.normal, 'disc normal');
    needPos(o.r, 'disc radius');
    needCount(o.segments, 'disc segments');
    const p = this.prim(m);
    const a = norm(o.normal);
    const [u, v] = basis(a);
    const to3 = (q: V2): V3 => add(o.centre, add(scale(u, q[0]), scale(v, q[1])));
    const holes = o.holes ?? [];
    const n = o.segments ?? this.segmentsFor(o.r);
    const outer = circle2([0, 0], o.r, n);
    checkHoles(outer, holes, this.segmentsFor);
    const rings = holes.map((h) => circle2(h.c, h.r, h.segments ?? this.segmentsFor(h.r)));
    const only = holes.length === 1 ? holes[0] : undefined;
    const inner = rings[0];
    if (only && inner?.length === n && Math.hypot(only.c[0], only.c[1]) < 1e-12) {
      // a concentric ring: a quad strip
      const ro = outer.map((q) => this.vertex(p, to3(q), a));
      const ri = inner.map((q) => this.vertex(p, to3(q), a));
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        this.quad(p, nth(ro, k), nth(ro, j), nth(ri, j), nth(ri, k));
      }
    } else {
      const ids = [outer, ...rings].flat().map((q) => this.vertex(p, to3(q), a));
      for (const [i, j, k] of triangulateWithHoles(outer, rings))
        this.tri(p, nth(ids, i), nth(ids, j), nth(ids, k));
    }
    if (o.declareHoles ?? true)
      for (const h of holes) this.opening(m, { centre: to3(h.c), normal: a, r: h.r });
  }

  /**
   * A flat slab with its top at `y` and its bottom `thickness` below, outline a polygon in
   * (x, z) or a circle (centred at `c`, default the origin), with circular through-holes, each
   * declared as an opening at mid-thickness.
   */
  slab(
    m: string,
    o: {
      y: number;
      outline: V2[] | { r: number; c?: V2; segments?: number };
      thickness: number;
      holes: Hole[];
    },
  ): void {
    need(Number.isFinite(o.y), 'slab level must be finite');
    needPos(o.thickness, 'slab thickness');
    if (Array.isArray(o.outline)) {
      need(o.outline.length >= 3, 'slab outline needs 3 or more points');
      need(
        o.outline.every((q) => finite(q[0], q[1])),
        'slab outline points must be finite',
      );
      need(Math.abs(area2(o.outline)) > 0, 'slab outline has no area');
    } else {
      need(o.outline.c === undefined || finite(...o.outline.c), 'slab centre must be finite');
      needPos(o.outline.r, 'slab radius');
      needCount(o.outline.segments, 'slab segments');
    }
    const p = this.prim(m);
    const y0 = o.y - o.thickness;
    const y1 = o.y;
    const circle = Array.isArray(o.outline) ? undefined : o.outline;
    const outer = Array.isArray(o.outline)
      ? o.outline
      : circle2(
          o.outline.c ?? [0, 0],
          o.outline.r,
          o.outline.segments ?? this.segmentsFor(o.outline.r),
        );
    checkHoles(outer, o.holes, this.segmentsFor);
    const rings = o.holes.map((h) => circle2(h.c, h.r, h.segments ?? this.segmentsFor(h.r)));
    const all = [outer, ...rings].flat();
    const tris = triangulateWithHoles(outer, rings);
    const at = (q: V2, y: number): V3 => [q[0], y, q[1]];
    const top = all.map((q) => this.vertex(p, at(q, y1), [0, 1, 0]));
    const bottom = all.map((q) => this.vertex(p, at(q, y0), [0, -1, 0]));
    for (const [i, j, k] of tris) {
      this.tri(p, nth(top, i), nth(top, j), nth(top, k));
      this.tri(p, nth(bottom, i), nth(bottom, k), nth(bottom, j));
    }
    // a smooth wall round a circle, normals away from (or, for a hole, towards) its centre
    const roundWall = (ring: V2[], c: V2, out: number) => {
      const nAt = (q: V2): V3 => [(q[0] - c[0]) * out, 0, (q[1] - c[1]) * out];
      const lo = ring.map((q) => this.vertex(p, at(q, y0), nAt(q)));
      const hi = ring.map((q) => this.vertex(p, at(q, y1), nAt(q)));
      for (let k = 0; k < ring.length; k++) {
        const j = (k + 1) % ring.length;
        this.quad(p, nth(lo, k), nth(lo, j), nth(hi, j), nth(hi, k));
      }
    };
    if (circle) roundWall(outer, circle.c ?? [0, 0], 1);
    else {
      const ccw = area2(outer) > 0;
      for (let i = 0; i < outer.length; i++) {
        const q = nth(outer, i);
        const r = nth(outer, (i + 1) % outer.length);
        const dx = r[0] - q[0];
        const dz = r[1] - q[1];
        if (Math.hypot(dx, dz) < 1e-12) continue;
        // in (x, z) a positive-area ring has its inside on the left of q->r: outward is the right
        const n: V3 = ccw ? [dz, 0, -dx] : [-dz, 0, dx];
        this.fan(p, [at(q, y0), at(r, y0), at(r, y1), at(q, y1)], n);
      }
    }
    o.holes.forEach((h, i) => {
      roundWall(nth(rings, i), h.c, -1);
      this.opening(m, { centre: [h.c[0], (y0 + y1) / 2, h.c[1]], normal: [0, 1, 0], r: h.r });
    });
  }

  /**
   * A box centred at `centre`, `size` along its own x, y, z. `yawDeg` turns it about its up axis
   * (counter-clockwise seen from above, as in the mesher); `up` (default +Y) tilts its y axis.
   */
  box(m: string, o: { centre: V3; size: V3; yawDeg?: number; up?: V3 }): void {
    need(finiteV(o.centre), 'box centre must be finite');
    need(
      o.size.every((s) => Number.isFinite(s) && s > 0),
      'box size must be finite and above zero',
    );
    need(o.yawDeg === undefined || Number.isFinite(o.yawDeg), 'box yaw must be finite');
    if (o.up) needDir(o.up, 'box up');
    const p = this.prim(m);
    const ey = norm(o.up ?? [0, 1, 0]);
    const yaw = ((o.yawDeg ?? 0) * Math.PI) / 180;
    const along = (x: V3) => sub(x, scale(ey, dot(x, ey)));
    let ex = along([Math.cos(yaw), 0, -Math.sin(yaw)]);
    if (len(ex) < 1e-6) ex = along([Math.sin(yaw), 0, Math.cos(yaw)]);
    ex = norm(ex);
    const ez = cross(ex, ey);
    const axes = [ex, ey, ez];
    const corner = (s: [number, number, number]): V3 =>
      s.reduce<V3>(
        (acc, sk, k) => add(acc, scale(nth(axes, k), sk * nth(o.size, k) * 0.5)),
        o.centre,
      );
    for (let k = 0; k < 3; k++) {
      const i = (k + 1) % 3;
      const j = (k + 2) % 3;
      for (const side of [-1, 1]) {
        const pts = (
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ] as const
        ).map(([si, sj]) => {
          const s: [number, number, number] = [0, 0, 0];
          s[k] = side;
          s[i] = si;
          s[j] = sj;
          return corner(s);
        });
        this.fan(p, pts, scale(nth(axes, k), side));
      }
    }
  }

  /** A square member of side `section` from `a` to `b`. */
  beam(m: string, a: V3, b: V3, section: number): void {
    need(finiteV(a, b), 'beam ends must be finite');
    needPos(section, 'beam section');
    const d = sub(b, a);
    const l = len(d);
    need(l > 1e-9, 'beam ends must be apart');
    this.box(m, { centre: scale(add(a, b), 0.5), size: [section, l, section], up: d });
  }

  /** A round bar of radius `r` from `a` to `b`, closed at both ends when `caps`. */
  rod(m: string, a: V3, b: V3, r: number, caps: boolean): void {
    need(finiteV(a, b), 'rod ends must be finite');
    needPos(r, 'rod radius');
    const d = sub(b, a);
    const l = len(d);
    need(l > 1e-9, 'rod ends must be apart');
    this.frustumShell(m, {
      base: a,
      axis: d,
      profile: [
        { y: 0, r },
        { y: l, r },
      ],
      capBottom: caps,
      capTop: caps,
    });
  }

  /**
   * A round section of radius `r` swept along `path`. Each corner becomes an arc of `bendRadius`
   * (default 1.5 r, shrunk where the legs are too short, see `bendStarts`); `bendRadius: 0`
   * mitres the corners. `startU` sets the section's start orientation (see `sweepFrame`).
   */
  sweep(
    m: string,
    path: V3[],
    r: number,
    o: { bendRadius?: number; capStart: boolean; capEnd: boolean; startU?: V3 },
  ): void {
    needPos(r, 'sweep radius');
    this.sweepSection(m, path, circleSection(r, this.segmentsFor(r)), o);
  }

  /**
   * A `w` x `h` rectangle swept along `path` (`h` along the frame's up-most direction, or `w`
   * along `startU` when given), corners as in `sweep` with a default bend radius of 1.5 x the
   * larger half-side.
   */
  rectSweep(
    m: string,
    path: V3[],
    w: number,
    h: number,
    caps: boolean,
    o: { bendRadius?: number; startU?: V3 } = {},
  ): void {
    needPos(w, 'rect sweep width');
    needPos(h, 'rect sweep height');
    this.sweepSection(m, path, rectSection(w, h), { ...o, capStart: caps, capEnd: caps });
  }

  /**
   * A torus of tube radius `r` round a circle of radius `R` about `axis`; `arcDeg` (from
   * `startDeg`, measured from the axis's `u`) makes a closed, end-capped part of it.
   */
  torus(
    m: string,
    o: { centre: V3; axis: V3; R: number; r: number; arcDeg?: number; startDeg?: number },
  ): void {
    need(finiteV(o.centre), 'torus centre must be finite');
    needDir(o.axis, 'torus axis');
    needPos(o.r, 'torus tube radius');
    need(Number.isFinite(o.R) && o.R > o.r, 'torus radius must exceed its tube radius');
    need(
      o.arcDeg === undefined || (Number.isFinite(o.arcDeg) && o.arcDeg > 0 && o.arcDeg <= 360),
      'torus arc must be above 0 and at most 360 degrees',
    );
    need(o.startDeg === undefined || Number.isFinite(o.startDeg), 'torus start must be finite');
    const p = this.prim(m);
    const a = norm(o.axis);
    const [u, v] = basis(a);
    const arc = Math.min(360, o.arcDeg ?? 360);
    const full = arc >= 360 - 1e-9;
    const nMaj = this.segmentsFor(o.R + o.r);
    const N = full ? nMaj : Math.max(2, Math.ceil((nMaj * arc) / 360));
    const M = this.segmentsFor(o.r);
    const start = ((o.startDeg ?? 0) * Math.PI) / 180;
    const span = (arc * Math.PI) / 180;
    const rings: number[][] = [];
    const centres: V3[] = [];
    const tangents: V3[] = [];
    for (let i = 0; i < (full ? N : N + 1); i++) {
      const phi = start + (span * i) / N;
      const w = add(scale(u, Math.cos(phi)), scale(v, Math.sin(phi)));
      const C = add(o.centre, scale(w, o.R));
      centres.push(C);
      tangents.push(add(scale(u, -Math.sin(phi)), scale(v, Math.cos(phi))));
      rings.push(
        Array.from({ length: M }, (_, j) => {
          const psi = (2 * Math.PI * j) / M;
          const nn = add(scale(w, Math.cos(psi)), scale(a, Math.sin(psi)));
          return this.vertex(p, add(C, scale(nn, o.r)), nn);
        }),
      );
    }
    for (let i = 0; i < N; i++) {
      const r0 = nth(rings, i);
      const r1 = nth(rings, (i + 1) % rings.length);
      for (let j = 0; j < M; j++) {
        const k = (j + 1) % M;
        this.quad(p, nth(r0, j), nth(r0, k), nth(r1, k), nth(r1, j));
      }
    }
    if (!full) {
      const capAt = (i: number, s: number) => {
        this.fan(
          p,
          nth(rings, i).map((id) => this.at(p, id)),
          scale(nth(tangents, i), s),
        );
      };
      capAt(0, -1);
      capAt(N, 1);
    }
  }

  /**
   * A side strip between two closed rings of equal length (a transition piece), normals pointing
   * away from the line through the ring centroids. Open at both rings.
   */
  loft(m: string, ringA: V3[], ringB: V3[]): void {
    const n = ringA.length;
    if (n < 3 || ringB.length !== n)
      throw new Error('geometry: loft needs two rings of the same length, at least 3');
    need(finiteV(...ringA, ...ringB), 'loft ring points must be finite');
    const p = this.prim(m);
    const centroid = (r: V3[]) => scale(r.reduce(add, [0, 0, 0]), 1 / r.length);
    const cA = centroid(ringA);
    const ax = norm(sub(centroid(ringB), cA));
    const faces: V3[] = [];
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const [a0, a1, b0, b1] = [nth(ringA, k), nth(ringA, j), nth(ringB, k), nth(ringB, j)];
      let f = cross(sub(b1, a0), sub(b0, a1));
      const mid = scale(add(add(a0, a1), add(b0, b1)), 0.25);
      const rel = sub(mid, cA);
      const radial = sub(rel, scale(ax, dot(rel, ax)));
      if (dot(f, radial) < 0) f = scale(f, -1);
      faces.push(norm(f));
    }
    const nAt = (k: number) => norm(add(nth(faces, (k + n - 1) % n), nth(faces, k)));
    const ia = ringA.map((q, k) => this.vertex(p, q, nAt(k)));
    const ib = ringB.map((q, k) => this.vertex(p, q, nAt(k)));
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      this.quad(p, nth(ia, k), nth(ia, j), nth(ib, j), nth(ib, k));
    }
  }

  private sweepSection(
    m: string,
    path: V3[],
    sec: Section,
    o: { bendRadius?: number; capStart: boolean; capEnd: boolean; startU?: V3 },
  ): void {
    need(finiteV(...path), 'sweep path points must be finite');
    if (o.startU) need(finiteV(o.startU), 'sweep start direction must be finite');
    need(
      o.bendRadius === undefined || (Number.isFinite(o.bendRadius) && o.bendRadius >= 0),
      'sweep bend radius must be finite and not negative',
    );
    const pts: V3[] = [];
    for (const q of path) {
      const last = pts.at(-1);
      if (!last || len(sub(q, last)) > 1e-9) pts.push(q);
    }
    need(pts.length >= 2, 'sweep path needs 2 or more distinct points');
    const p = this.prim(m);
    const dirs = legDirs(pts);
    const R0 = o.bendRadius ?? 1.5 * sec.reach;
    const starts = bendStarts(pts, R0);
    const first = nth(dirs, 0);
    const stations: Station[] = [{ c: nth(pts, 0), tIn: first, tOut: first }];
    const push = (s: Station) => {
      const last = stations.at(-1);
      if (last && len(sub(s.c, last.c)) < 1e-9) return;
      stations.push(s);
    };
    for (let i = 1; i + 1 < pts.length; i++) {
      const dIn = nth(dirs, i - 1);
      const dOut = nth(dirs, i);
      const P = nth(pts, i);
      const theta = Math.acos(Math.max(-1, Math.min(1, dot(dIn, dOut))));
      need(theta < Math.PI - 1e-3, 'sweep path doubles back on itself');
      if (theta < 1e-6) continue;
      const tanHalf = Math.tan(theta / 2);
      const t = nth(starts, i);
      if (t < 1e-9) {
        push({ c: P, tIn: dIn, tOut: dOut });
        continue;
      }
      const R = t / tanHalf;
      const k = norm(sub(dOut, scale(dIn, dot(dIn, dOut))));
      const S = sub(P, scale(dIn, t));
      const O = add(S, scale(k, R));
      const steps = Math.max(2, Math.ceil((this.segmentsFor(sec.reach) * theta) / Math.PI));
      for (let j = 0; j <= steps; j++) {
        const phi = (theta * j) / steps;
        const c = add(O, scale(add(scale(k, -Math.cos(phi)), scale(dIn, Math.sin(phi))), R));
        const tj = norm(add(scale(dIn, Math.cos(phi)), scale(k, Math.sin(phi))));
        push({ c, tIn: tj, tOut: tj });
      }
    }
    const lastDir = nth(dirs, dirs.length - 1);
    push({ c: nth(pts, pts.length - 1), tIn: lastDir, tOut: lastDir });

    // frames by parallel transport; rings and normals on both sides of each station
    const t0 = nth(stations, 0).tOut;
    let u = sweepStartU(t0, o.startU);
    let prevT = t0;
    const ringOf = (uu: V3, vv: V3, c: V3) =>
      sec.pts.map((q) => add(c, add(scale(uu, q[0]), scale(vv, q[1]))));
    const normalsOf = (uu: V3, vv: V3) => sec.nrm.map((q) => add(scale(uu, q[0]), scale(vv, q[1])));
    const built = stations.map((s) => {
      u = norm(transport(u, prevT, s.tIn));
      u = norm(sub(u, scale(s.tIn, dot(u, s.tIn))));
      const vIn = cross(u, s.tIn);
      let ring = ringOf(u, vIn, s.c);
      const nIn = normalsOf(u, vIn);
      let nOut = nIn;
      if (len(sub(s.tIn, s.tOut)) > 1e-9) {
        // mitre: project the incoming ring onto the plane halfway between the legs
        const mp = norm(add(s.tIn, s.tOut), s.tOut);
        ring = ring.map((q) => add(q, scale(s.tIn, dot(sub(s.c, q), mp) / dot(s.tIn, mp))));
        u = norm(transport(u, s.tIn, s.tOut));
        nOut = normalsOf(u, cross(u, s.tOut));
      }
      prevT = s.tOut;
      return { ring, nIn, nOut, s };
    });
    for (let i = 0; i + 1 < built.length; i++) {
      const A = nth(built, i);
      const B = nth(built, i + 1);
      const ia = A.ring.map((q, k) => this.vertex(p, q, nth(A.nOut, k)));
      const ib = B.ring.map((q, k) => this.vertex(p, q, nth(B.nIn, k)));
      for (const [k, l] of sec.strips) this.quad(p, nth(ia, k), nth(ia, l), nth(ib, l), nth(ib, k));
    }
    const head = nth(built, 0);
    const tail = nth(built, built.length - 1);
    if (o.capStart)
      this.fan(
        p,
        sec.cap.map((k) => nth(head.ring, k)),
        scale(head.s.tOut, -1),
      );
    if (o.capEnd)
      this.fan(
        p,
        sec.cap.map((k) => nth(tail.ring, k)),
        tail.s.tIn,
      );
  }
}
