/**
 * Builders of line assemblies: ducts (with a rectangle-to-round transition piece), pipe runs
 * with bends and flanges, and earthing conductors. Each is swept along its path by the kernel,
 * capped at both ends (a solid), with bends as arcs so a run is one continuous piece.
 *
 * A duct transition is a separate fitting between two collars: the duct before it ends inside
 * the first collar, the lofted transition sits between them and the duct after it starts inside
 * the second, so every piece is a closed solid and the joints are hidden.
 *
 * Default materials (ids `DEFAULT_MATERIALS` carries): duct and pipe `steel-galv`, earthing
 * `copper`.
 */
import type { AssemblyParams } from '@aio/schema';
import {
  add,
  bendStarts,
  dot,
  legDirs,
  len,
  scale,
  sub,
  sweepFrame,
  type MeshSink,
  type V2,
  type V3,
} from '../geom';
import { checkPath, orientedBox } from './access';
import type { AssemblyOf, BuildCtx, BuilderTable } from './ctx';

type Section = AssemblyParams<'duct'>['section'];

/** Duct collar and flange thickness. */
const DUCT_FLANGE_T = 0.03;

function fail(what: string): never {
  throw new Error(`geometry: ${what}`);
}

function pick<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) fail(`index ${String(i)} out of range`);
  return x;
}

type Frame = ReturnType<typeof sweepFrame>;

const reachOf = (s: Section) => ('rect' in s ? Math.max(s.rect[0], s.rect[1]) / 2 : s.round);
/** How far a duct flange or collar stands proud of the section. */
const flangeMargin = (s: Section) => Math.max(0.03, 0.1 * reachOf(s));

/**
 * Points round a `w` x `h` rectangle (x across, y up), counter-clockwise from its (+x, -y)
 * corner, all four corners included and the rest shared out to the longest spacing.
 */
function rectRing(w: number, h: number, n: number): V2[] {
  const corners: V2[] = [
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
    [-w / 2, -h / 2],
  ];
  const sides = [h, w, h, w];
  const counts = [1, 1, 1, 1];
  for (let extra = n - 4; extra > 0; extra--) {
    let best = 0;
    for (let k = 1; k < 4; k++)
      if (pick(sides, k) / pick(counts, k) > pick(sides, best) / pick(counts, best)) best = k;
    counts[best] = pick(counts, best) + 1;
  }
  const out: V2[] = [];
  for (let k = 0; k < 4; k++) {
    const a = pick(corners, k);
    const b = pick(corners, (k + 1) % 4);
    const m = pick(counts, k);
    for (let j = 0; j < m; j++)
      out.push([a[0] + ((b[0] - a[0]) * j) / m, a[1] + ((b[1] - a[1]) * j) / m]);
  }
  return out;
}

/**
 * The two rings of a transition between sections `a` and `b`, with the same number of points
 * each: a rectangle is resampled to the circle's segment count, and a circle takes the angles of
 * the rectangle's points so the strip between them does not twist.
 */
function transitionRings(a: Section, b: Section, n: number): [V2[], V2[]] {
  const circleAt = (r: number, like: V2[]): V2[] =>
    like.map((q) => {
      const t = Math.atan2(q[1], q[0]);
      return [r * Math.cos(t), r * Math.sin(t)];
    });
  const uniform = (r: number): V2[] =>
    Array.from({ length: n }, (_, k) => {
      const t = (2 * Math.PI * k) / n;
      return [r * Math.cos(t), r * Math.sin(t)];
    });
  if ('rect' in a) {
    const [wa, ha] = a.rect;
    const ra = rectRing(wa, ha, n);
    if (!('rect' in b)) return [ra, circleAt(b.round, ra)];
    // rectangle to rectangle: the same points stretched, corner to corner
    const [wb, hb] = b.rect;
    return [ra, ra.map((q): V2 => [(q[0] * wb) / wa, (q[1] * hb) / ha])];
  }
  if ('rect' in b) {
    const rb = rectRing(b.rect[0], b.rect[1], n);
    return [circleAt(a.round, rb), rb];
  }
  return [uniform(a.round), uniform(b.round)];
}

const place = (c: V3, f: Frame, q: V2): V3 => add(c, add(scale(f.u, q[0]), scale(f.v, q[1])));

/** A flat cap over a closed ring: a fan from its centre `c`, so collinear ring points are fine. */
function capRing(sink: MeshSink, m: string, ring: readonly V3[], c: V3, normal: V3): void {
  const p = sink.prim(m);
  const ci = sink.vertex(p, c, normal);
  const ids = ring.map((q) => sink.vertex(p, q, normal));
  for (let k = 0; k < ids.length; k++)
    sink.tri(p, ci, pick(ids, k), pick(ids, (k + 1) % ids.length));
}

/**
 * A duct along `path` with a rect or round section. With `transition`, the section changes on
 * the leg leaving point `at` (after its bend): collar, lofted transition piece, collar, then the
 * new section to the end. `flanges` adds a flange at each end of the duct.
 */
export function buildDuct(sink: MeshSink, a: AssemblyOf<'duct'>, ctx: BuildCtx): void {
  const d = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  const path = d.path;
  checkPath(path, 'duct');
  const tf = DUCT_FLANGE_T;
  const sweep = (s: Section, pts: V3[], startU?: V3) => {
    const o = startU ? { startU } : {};
    if ('rect' in s) sink.rectSweep(m, pts, s.rect[0], s.rect[1], true, o);
    else sink.sweep(m, pts, s.round, { capStart: true, capEnd: true, ...o });
  };
  /** A collar or flange `tf` thick centred at `c`, square to the frame's path direction. */
  const collar = (s: Section, c: V3, f: Frame) => {
    const e = flangeMargin(s);
    if ('rect' in s)
      orientedBox(sink, m, c, [f.u, f.v, f.t], [s.rect[0] / 2 + e, s.rect[1] / 2 + e, tf / 2]);
    else sink.rod(m, sub(c, scale(f.t, tf / 2)), add(c, scale(f.t, tf / 2)), s.round + e, true);
  };
  // end flanges stand a quarter of their thickness past the duct ends, hiding the end caps' rims
  const startFlange = (s: Section, pts: V3[]) => {
    const f = sweepFrame(pts, 0);
    collar(s, add(pick(pts, 0), scale(f.t, tf / 4)), f);
  };
  const endFlange = (s: Section, pts: V3[], startU?: V3) => {
    const f = sweepFrame(pts, pts.length - 2, startU);
    collar(s, sub(pick(pts, pts.length - 1), scale(f.t, tf / 4)), f);
  };
  const tr = d.transition;
  if (!tr) {
    sweep(d.section, path);
    if (d.flanges) {
      startFlange(d.section, path);
      endFlange(d.section, path);
    }
    return;
  }
  const at = tr.at;
  if (at > path.length - 2) fail('duct transition must start before the last point of the path');
  const A = d.section;
  const B = tr.to;
  const dirs = legDirs(path);
  const dir = pick(dirs, at);
  const P = pick(path, at);
  const legLength = len(sub(pick(path, at + 1), P));
  // where the section A duct ends: past the bend at `at` (the kernel's default bend radius)
  let s0 = tf / 2;
  if (at > 0) {
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(pick(dirs, at - 1), dir))));
    s0 = (theta < 1e-6 ? 0 : 1.5 * reachOf(A) * Math.tan(theta / 2)) + tf;
  }
  const gap = tf / 4;
  const want = 2 * Math.max(reachOf(A), reachOf(B));
  const length = Math.min(want, legLength - s0 - 3 * gap - tf);
  if (length < want / 4) fail(`duct leg after point ${String(at)} is too short for the transition`);
  const along = (x: number) => add(P, scale(dir, x));
  const j1 = along(s0);
  const t0 = along(s0 + gap);
  const t1 = along(s0 + gap + length);
  const j2 = along(s0 + 2 * gap + length);
  const after: V3[] = [along(s0 + 3 * gap + length), ...path.slice(at + 1)];
  const before: V3[] = [...path.slice(0, at + 1), j1];
  // the duct after the transition starts on the frame the duct before it arrives with, so a
  // rectangle at either end (or both) lines up and nothing rolls
  const fA = sweepFrame(path, at);
  const fB = sweepFrame(after, 0, fA.u);
  if (at > 0) {
    sweep(A, before);
    if (d.flanges) startFlange(A, before);
  }
  // The collars stay even with `flanges` false: welding the loft straight onto a swept duct would
  // leave T-junctions (a rect sweep's end ring has 4 corners, the loft ring n points), so the
  // pieces end inside the collars instead, each a closed solid with no shared faces.
  collar(A, j1, fA);
  const n = sink.segmentsFor(Math.max(reachOf(A), reachOf(B)));
  const [ra, rb] = transitionRings(A, B, n);
  const ringA = ra.map((q) => place(t0, fA, q));
  const ringB = rb.map((q) => place(t1, fB, q));
  sink.loft(m, ringA, ringB);
  capRing(sink, m, ringA, t0, scale(dir, -1));
  capRing(sink, m, ringB, t1, dir);
  collar(B, j2, fB);
  sweep(B, after, fA.u);
  if (d.flanges) endFlange(B, after, fA.u);
}

/**
 * A pipe of `diameter` along `path`, bends of `bendRadius` (default 1.5 x the pipe radius),
 * ends capped unless `openEnds` leaves them open (each open end is declared as an opening); a
 * flange disc at each listed point index: at an end with its face just past the pipe end, at a
 * corner where the bend starts, so every flange sits on the pipe.
 */
export function buildPipeRun(sink: MeshSink, a: AssemblyOf<'pipeRun'>, ctx: BuildCtx): void {
  const pr = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  const path = pr.path;
  checkPath(path, 'pipe run');
  const r = pr.diameter / 2;
  const flanges = [...new Set(pr.flanges ?? [])].sort((x, y) => x - y);
  const lastIndex = path.length - 1;
  for (const i of flanges)
    if (i > lastIndex) fail(`pipe flange at point ${String(i)} is past the end of the path`);
  const bendRadius = pr.bendRadius ?? 1.5 * r; // the kernel's default, named for the flanges
  const open = pr.openEnds ?? 'none';
  const openStart = open === 'start' || open === 'both';
  const openEnd = open === 'end' || open === 'both';
  sink.sweep(m, path, r, { bendRadius, capStart: !openStart, capEnd: !openEnd });
  const dirs = legDirs(path);
  if (openStart) sink.opening(m, { centre: pick(path, 0), normal: scale(pick(dirs, 0), -1), r });
  if (openEnd)
    sink.opening(m, { centre: pick(path, lastIndex), normal: pick(dirs, lastIndex - 1), r });
  const rf = 1.6 * r;
  const tf = Math.max(0.02, 0.25 * r);
  const starts = bendStarts(path, bendRadius);
  for (const i of flanges) {
    const P = pick(path, i);
    let c: V3;
    let t: V3;
    if (i === 0) {
      t = pick(dirs, 0);
      c = add(P, scale(t, tf / 4));
    } else if (i === lastIndex) {
      t = pick(dirs, lastIndex - 1);
      c = sub(P, scale(t, tf / 4));
    } else {
      t = pick(dirs, i - 1);
      c = sub(P, scale(t, pick(starts, i)));
    }
    sink.rod(m, sub(c, scale(t, tf / 2)), add(c, scale(t, tf / 2)), rf, true);
  }
}

/** An earthing conductor: a thin round bar along `path`, capped at both ends. */
export function buildEarthing(sink: MeshSink, a: AssemblyOf<'earthing'>, ctx: BuildCtx): void {
  const e = a.params;
  checkPath(e.path, 'earthing');
  sink.sweep(ctx.material(a.material, 'copper'), e.path, e.diameter / 2, {
    capStart: true,
    capEnd: true,
  });
}

export const LINE_BUILDERS = {
  duct: buildDuct,
  pipeRun: buildPipeRun,
  earthing: buildEarthing,
} satisfies BuilderTable;
