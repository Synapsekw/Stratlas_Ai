/**
 * Builders of access steelwork: ring platforms, guardrails, caged ladders, deck hatches and
 * louvres. Every part is built from closed solids; parts of one assembly that would only touch
 * (a rung in a stile, a rail through a post) overlap instead of sharing vertices, so each stays a
 * closed piece of its own.
 *
 * Default materials (ids `DEFAULT_MATERIALS` carries): platform `grating`, everything else
 * `steel-galv`, a ladder's cage always `steel-galv-cage`.
 */
import { add, basis, cross, dot, len, norm, scale, sub, type MeshSink, type V3 } from '../geom';
import type { AssemblyOf, BuildCtx, BuilderTable } from './ctx';

const UP: V3 = [0, 1, 0];
const X: V3 = [1, 0, 0];
const Z: V3 = [0, 0, 1];
/** Most posts, rungs or hoops one assembly may have. */
const MAX_PIECES = 2000;

/** Guardrail post and rail radii (48 and 42 mm tube). */
const POST_R = 0.024;
const RAIL_R = 0.021;
/** Gap where a closed rail loop meets itself, hidden in a post. */
const RAIL_SEAM = 0.001;

/** Ladder stiles and rungs; the cage's hoops (tube radius), bars, radius and spacing. */
const STILE_R = 0.025;
const RUNG_R = 0.0125;
const HOOP_TUBE = 0.02;
const CAGE_BAR_R = 0.012;
const CAGE_R = 0.36;
const HOOP_PITCH = 0.9;
const CAGE_FROM = 2.2;
const CAGE_BARS = 5;

/** Hatch frame width and upstand, lid plate thickness. */
const HATCH_FRAME_W = 0.05;
const HATCH_FRAME_H = 0.05;
const HATCH_LID_T = 0.01;

/** Louvre frame depth and largest frame width; blade thickness, tilt and end clearance. */
const LOUVRE_DEPTH = 0.1;
const LOUVRE_FRAME = 0.05;
const BLADE_T = 0.003;
const BLADE_TILT = (40 * Math.PI) / 180;
const BLADE_CLEAR = 0.002;

function fail(what: string): never {
  throw new Error(`geometry: ${what}`);
}

function pick<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) fail(`index ${String(i)} out of range`);
  return x;
}

/** Consecutive points of `path` must be apart. */
export function checkPath(path: readonly V3[], what: string): void {
  for (let i = 1; i < path.length; i++)
    if (len(sub(pick(path, i), pick(path, i - 1))) < 1e-9)
      fail(`${what} path has two equal points in a row`);
}

/**
 * A closed box centred at `c` with orthonormal `axes` and half sizes `half` along them: flat
 * faces, so its edges are hard.
 */
export function orientedBox(
  sink: MeshSink,
  m: string,
  c: V3,
  axes: readonly [V3, V3, V3],
  half: readonly [number, number, number],
): void {
  if (!half.every((h) => Number.isFinite(h) && h > 0)) fail('box size must be above zero');
  const p = sink.prim(m);
  for (let k = 0; k < 3; k++) {
    const i = (k + 1) % 3;
    const j = (k + 2) % 3;
    for (const side of [-1, 1]) {
      const face = scale(pick(axes, k), side * pick(half, k));
      const pts = (
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const
      ).map(([si, sj]) =>
        add(
          c,
          add(
            face,
            add(scale(pick(axes, i), si * pick(half, i)), scale(pick(axes, j), sj * pick(half, j))),
          ),
        ),
      );
      sink.fan(p, pts, scale(pick(axes, k), side));
    }
  }
}

/**
 * A closed rectangular frame: the ring between an `outer` and an `inner` rectangle (sizes along
 * `a` and `b`) centred at `c`, `depth` deep along `n`.
 */
function rectFrame(
  sink: MeshSink,
  m: string,
  o: {
    c: V3;
    a: V3;
    b: V3;
    n: V3;
    outer: [number, number];
    inner: [number, number];
    depth: number;
  },
): void {
  const p = sink.prim(m);
  const corners = ([w, h]: [number, number]) =>
    (
      [
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ] as const
    ).map(([s, t]) => add(o.c, add(scale(o.a, (s * w) / 2), scale(o.b, (t * h) / 2))));
  const O = corners(o.outer);
  const I = corners(o.inner);
  const off = (q: V3, s: number) => add(q, scale(o.n, (s * o.depth) / 2));
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    const [ok, oj, ik, ij] = [pick(O, k), pick(O, j), pick(I, k), pick(I, j)];
    for (const s of [-1, 1])
      sink.fan(p, [off(ok, s), off(oj, s), off(ij, s), off(ik, s)], scale(o.n, s));
    // the side faces outwards on the outer edge and towards the middle on the inner edge
    const outward = norm(sub(scale(add(ok, oj), 0.5), o.c));
    sink.fan(p, [off(ok, -1), off(oj, -1), off(oj, 1), off(ok, 1)], outward);
    sink.fan(p, [off(ik, -1), off(ij, -1), off(ij, 1), off(ik, 1)], scale(outward, -1));
  }
}

/** A flat annular slab round the vertical axis, top at `y`, over `arcDeg` from +x towards +z. */
export function buildRingPlatform(
  sink: MeshSink,
  a: AssemblyOf<'ringPlatform'>,
  ctx: BuildCtx,
): void {
  const r = a.params;
  const m = ctx.material(a.material, 'grating');
  if (!(r.rOuter > r.rInner)) fail('platform outer radius must exceed the inner');
  const arc = r.arcDeg ?? 360;
  const nFull = sink.segmentsFor(r.rOuter);
  const y0 = r.y - r.thickness;
  const y1 = r.y;
  if (arc >= 360 - 1e-9) {
    sink.annulusTube(m, {
      centre: [0, 0, 0],
      axis: UP,
      rOuter: r.rOuter,
      rInner: r.rInner,
      y0,
      y1,
      segments: nFull,
      openings: 'none',
    });
    return;
  }
  const n = Math.max(2, Math.ceil((nFull * arc) / 360));
  const span = (arc * Math.PI) / 180;
  const p = sink.prim(m);
  const dir = (k: number): V3 => {
    const t = (span * k) / n;
    return [Math.cos(t), 0, Math.sin(t)];
  };
  const at = (k: number, rad: number, y: number): V3 => add(scale(dir(k), rad), [0, y, 0]);
  for (let k = 0; k < n; k++) {
    for (const [y, nrm] of [
      [y1, UP],
      [y0, scale(UP, -1)],
    ] as const)
      sink.fan(
        p,
        [at(k, r.rInner, y), at(k, r.rOuter, y), at(k + 1, r.rOuter, y), at(k + 1, r.rInner, y)],
        nrm,
      );
  }
  // smooth curved walls, outer facing out and inner facing the axis
  for (const [rad, s] of [
    [r.rOuter, 1],
    [r.rInner, -1],
  ] as const) {
    const lo = Array.from({ length: n + 1 }, (_, k) =>
      sink.vertex(p, at(k, rad, y0), scale(dir(k), s)),
    );
    const hi = Array.from({ length: n + 1 }, (_, k) =>
      sink.vertex(p, at(k, rad, y1), scale(dir(k), s)),
    );
    for (let k = 0; k < n; k++)
      sink.quad(p, pick(lo, k), pick(lo, k + 1), pick(hi, k + 1), pick(hi, k));
  }
  const end = (k: number, nrm: V3) => {
    sink.fan(
      p,
      [at(k, r.rInner, y0), at(k, r.rOuter, y0), at(k, r.rOuter, y1), at(k, r.rInner, y1)],
      nrm,
    );
  };
  end(0, [0, 0, -1]);
  end(n, [-Math.sin(span), 0, Math.cos(span)]);
}

/** Posts at the requested spacing (at most) and 1 to 3 rails, the top one over the post tops. */
export function buildGuardrail(sink: MeshSink, a: AssemblyOf<'guardrail'>, ctx: BuildCtx): void {
  const g = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  const railHeights = Array.from({ length: g.rails }, (_, k) => (g.height * (k + 1)) / g.rails);
  const post = (foot: V3) => {
    sink.rod(m, foot, add(foot, [0, g.height, 0]), POST_R, true);
  };
  if (!Array.isArray(g.path)) {
    const { y, r } = g.path;
    const n = Math.max(3, Math.ceil((2 * Math.PI * r) / g.posts - 1e-9));
    if (n > MAX_PIECES) fail(`guardrail posts are too close (over ${String(MAX_PIECES)})`);
    for (let k = 0; k < n; k++) {
      const t = (2 * Math.PI * k) / n;
      post([r * Math.cos(t), y, r * Math.sin(t)]);
    }
    for (const h of railHeights)
      sink.torus(m, { centre: [0, y + h, 0], axis: UP, R: r, r: RAIL_R });
    return;
  }
  const path = g.path;
  checkPath(path, 'guardrail');
  const first = pick(path, 0);
  const last = pick(path, path.length - 1);
  const closed = path.length >= 4 && len(sub(first, last)) < 1e-6;
  const legs = path.slice(1).map((q, i) => {
    const from = pick(path, i);
    const l = len(sub(q, from));
    return { from, d: norm(sub(q, from)), l, n: Math.max(1, Math.ceil(l / g.posts - 1e-9)) };
  });
  const count = legs.reduce((s, l) => s + l.n, closed ? 0 : 1);
  if (count > MAX_PIECES) fail(`guardrail posts are too close (over ${String(MAX_PIECES)})`);
  for (const l of legs)
    for (let j = 0; j < l.n; j++) post(add(l.from, scale(l.d, (l.l * j) / l.n)));
  if (!closed) post(last);
  // a closed loop starts and ends its rails at a post on the first leg (its middle if it has none)
  const leg0 = pick(legs, 0);
  const seam = leg0.n >= 2 ? leg0.l / leg0.n : leg0.l / 2;
  const railPath: V3[] = closed
    ? [
        add(first, scale(leg0.d, seam + RAIL_SEAM / 2)),
        ...path.slice(1),
        add(first, scale(leg0.d, seam - RAIL_SEAM / 2)),
      ]
    : path;
  for (const h of railHeights)
    sink.sweep(
      m,
      railPath.map((q) => add(q, [0, h, 0])),
      RAIL_R,
      { bendRadius: 0, capStart: true, capEnd: true },
    );
}

/**
 * Two stiles and rungs at `rungSpacing` (none at the bottom or the top). The ladder's face is
 * across the horizontal line from the shaft axis (the vertical through the origin; +z when it
 * stands on it); the cage, when there is one, stands out on that side in its own material.
 */
export function buildLadder(sink: MeshSink, a: AssemblyOf<'ladder'>, ctx: BuildCtx): void {
  const l = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  const along = sub(l.top, l.bottom);
  const length = len(along);
  if (length < 1e-6) fail('ladder top and bottom must be apart');
  const d = norm(along);
  const mid = scale(add(l.bottom, l.top), 0.5);
  const radial: V3 = [mid[0], 0, mid[2]];
  let out = len(radial) > 1e-6 ? norm(radial) : Z;
  let side = cross(d, out);
  if (len(side) < 1e-6) side = basis(d)[0];
  side = norm(side);
  out = norm(cross(side, d));
  const hw = l.width / 2;
  if (hw <= STILE_R) fail('ladder is narrower than its stiles');
  const rungs = Math.ceil(length / l.rungSpacing - 1e-9) - 1;
  if (rungs > MAX_PIECES) fail(`ladder rungs are too close (over ${String(MAX_PIECES)})`);
  for (const s of [-1, 1]) {
    const o = scale(side, s * hw);
    sink.rod(m, add(l.bottom, o), add(l.top, o), STILE_R, true);
  }
  for (let k = 1; k <= rungs; k++) {
    const c = add(l.bottom, scale(d, k * l.rungSpacing));
    sink.rod(m, sub(c, scale(side, hw)), add(c, scale(side, hw)), RUNG_R, true);
  }
  if (!l.cage) return;
  const mc = 'steel-galv-cage';
  // hoops through both stiles, round the climber on the outer side
  const R = Math.max(CAGE_R, hw + 0.1);
  const off = Math.sqrt(R * R - hw * hw);
  const start = Math.min(CAGE_FROM, length / 2);
  const heights: number[] = [];
  const steps = Math.floor((length - start) / HOOP_PITCH + 1e-9);
  for (let k = 0; k <= steps; k++) heights.push(start + k * HOOP_PITCH);
  if (length - (heights.at(-1) ?? start) > HOOP_PITCH / 3) heights.push(length);
  if (heights.length > MAX_PIECES) fail(`ladder cage has over ${String(MAX_PIECES)} hoops`);
  const [bu, bv] = basis(d);
  const angle = (w: V3) => Math.atan2(dot(w, bv), dot(w, bu));
  const turn = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const t1 = angle(sub(scale(side, hw), scale(out, off)));
  const t2 = angle(sub(scale(side, -hw), scale(out, off)));
  let from = t1;
  let span = turn(t2 - t1);
  if (turn(angle(out) - t1) > span) {
    from = t2;
    span = 2 * Math.PI - span;
  }
  const axisAt = (h: number) => add(add(l.bottom, scale(d, h)), scale(out, off));
  for (const h of heights)
    sink.torus(mc, {
      centre: axisAt(h),
      axis: d,
      R,
      r: HOOP_TUBE,
      arcDeg: (span * 180) / Math.PI,
      startDeg: (from * 180) / Math.PI,
    });
  for (let j = 1; j <= CAGE_BARS; j++) {
    const t = from + (span * j) / (CAGE_BARS + 1);
    const foot = add(axisAt(start), scale(add(scale(bu, Math.cos(t)), scale(bv, Math.sin(t))), R));
    sink.rod(mc, foot, add(foot, scale(d, length - start)), CAGE_BAR_R, true);
  }
}

/**
 * A deck hatch: a frame round the `size` opening standing on the deck at `centre`, and a lid
 * resting on it, or stood upright on its +x hinge when `open` (the opening is then declared).
 */
export function buildHatch(sink: MeshSink, a: AssemblyOf<'hatch'>, ctx: BuildCtx): void {
  const h = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  const [w, dz] = h.size;
  const c = h.centre;
  const f = HATCH_FRAME_W;
  rectFrame(sink, m, {
    c: add(c, [0, HATCH_FRAME_H / 2, 0]),
    a: X,
    b: Z,
    n: UP,
    outer: [w + 2 * f, dz + 2 * f],
    inner: [w, dz],
    depth: HATCH_FRAME_H,
  });
  const top = c[1] + HATCH_FRAME_H;
  // the lid covers the opening and half the frame
  const lw = w + f;
  const ld = dz + f;
  const t = HATCH_LID_T;
  const axes: [V3, V3, V3] = [X, UP, Z];
  if (!h.open) {
    orientedBox(sink, m, [c[0], top + t / 2, c[2]], axes, [lw / 2, t / 2, ld / 2]);
    return;
  }
  orientedBox(sink, m, [c[0] + lw / 2 + t / 2, top + lw / 2, c[2]], axes, [t / 2, lw / 2, ld / 2]);
  sink.opening(m, { centre: [c[0], top, c[2]], normal: UP, r: Math.min(w, dz) / 2 });
}

/**
 * A louvre facing `normal`: a frame `size` across (width horizontal, height up the wall) and
 * `blades` thin blades tilted 40 degrees, sloping down outwards, clear of the frame and of each
 * other.
 */
export function buildLouvre(sink: MeshSink, a: AssemblyOf<'louvre'>, ctx: BuildCtx): void {
  const lv = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  const n = norm(lv.normal);
  let e = sub(UP, scale(n, dot(UP, n)));
  e = len(e) > 1e-6 ? norm(e) : basis(n)[1];
  const s = norm(cross(e, n));
  const [w, h] = lv.size;
  const f = Math.min(LOUVRE_FRAME, 0.15 * Math.min(w, h));
  const wi = w - 2 * f;
  const hi = h - 2 * f;
  const pitch = hi / lv.blades;
  const cos = Math.cos(BLADE_TILT);
  const sin = Math.sin(BLADE_TILT);
  if (pitch * cos <= 2 * BLADE_T || wi <= 4 * BLADE_CLEAR)
    fail('louvre is too small for that many blades');
  rectFrame(sink, m, {
    c: lv.centre,
    a: s,
    b: e,
    n,
    outer: [w, h],
    inner: [wi, hi],
    depth: LOUVRE_DEPTH,
  });
  const chord = Math.min((0.95 * LOUVRE_DEPTH) / cos, (0.95 * (pitch - BLADE_T * cos)) / sin);
  const across = norm(sub(scale(n, cos), scale(e, sin)));
  const bladeN = norm(cross(across, s));
  for (let k = 0; k < lv.blades; k++) {
    const c = add(lv.centre, scale(e, -hi / 2 + pitch * (k + 0.5)));
    orientedBox(sink, m, c, [s, bladeN, across], [wi / 2 - BLADE_CLEAR, BLADE_T / 2, chord / 2]);
  }
}

export const ACCESS_BUILDERS = {
  ringPlatform: buildRingPlatform,
  guardrail: buildGuardrail,
  ladder: buildLadder,
  hatch: buildHatch,
  louvre: buildLouvre,
} satisfies BuilderTable;
