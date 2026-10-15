/**
 * Builders of the shaft family: the shaft itself, paint bands round it, flues standing out of
 * its top, flare tips, decks and bases. Each writes one assembly onto a `MeshSink`; shells, rims
 * and caps that meet are built with one segment count so their rings weld.
 *
 * Default materials (ids `DEFAULT_MATERIALS` carries): shaft, deck and base `concrete-grey`, flue
 * and flare tip `stainless`, joints `joint`, flare lining `refractory`, windshield `steel-sheet`
 * (a doubleSided sheet). A band always uses its own `material` param.
 */
import { add, scale, type MeshSink, type V3 } from '../geom';
import {
  profileRadiusAt,
  shaftAxis,
  shaftHeightAt,
  type AssemblyOf,
  type BuildCtx,
  type BuilderTable,
} from './ctx';

/** How far a band stands proud of the shaft, and how far its inner face sinks into it. */
const BAND_PROUD = 0.01;
const BAND_SINK = 0.002;
/** Tube radius of a joint ring: it stands 1 cm proud of the shaft surface. */
const JOINT_R = 0.01;
const MAX_JOINTS = 2000;

function fail(what: string): never {
  throw new Error(`geometry: ${what}`);
}

function ends<T>(xs: readonly T[], what: string): [T, T] {
  const a = xs[0];
  const b = xs.at(-1);
  if (a === undefined || b === undefined) fail(`${what} needs points`);
  return [a, b];
}

/**
 * Concentric flat ring facing `normal` between radii `rIn` and `rOut` at `centre`, built with
 * `n` segments so it welds to shells of the same count. Closes a solid, so its hole is no opening.
 */
function rim(
  sink: MeshSink,
  m: string,
  o: { centre: V3; normal: V3; rOut: number; rIn: number; n: number },
): void {
  sink.disc(m, {
    centre: o.centre,
    normal: o.normal,
    r: o.rOut,
    segments: o.n,
    holes: [{ c: [0, 0], r: o.rIn, segments: o.n }],
    declareHoles: false,
  });
}

export function buildShaft(sink: MeshSink, a: AssemblyOf<'shaft'>, ctx: BuildCtx): void {
  const p = a.params;
  const m = ctx.material(a.material, 'concrete-grey');
  const axis = shaftAxis(p);
  const prof = p.profile;
  const [bottom, top] = ends(prof, 'shaft profile');
  const at = (h: number): V3 => add(p.base, scale(axis, h));
  if (p.wall === undefined) {
    sink.frustumShell(m, { base: p.base, axis, profile: prof, capBottom: true, capTop: true });
  } else {
    const wall = p.wall;
    const n = sink.segmentsFor(Math.max(...prof.map((q) => q.r)));
    // a closed top keeps a roof `wall` thick over the bore
    const roof = top.y - wall;
    if (!p.openTop && roof <= bottom.y) fail('shaft wall must be thinner than the shaft is tall');
    const bore = p.openTop
      ? prof.map((q) => ({ y: q.y, r: q.r - wall }))
      : [
          ...prof.filter((q) => q.y < roof - 1e-9).map((q) => ({ y: q.y, r: q.r - wall })),
          { y: roof, r: profileRadiusAt(prof, roof) - wall },
        ];
    if (!bore.every((q) => q.r > 0)) fail('shaft wall must be thinner than the shaft radius');
    const [boreBottom, boreTop] = ends(bore, 'shaft bore');
    const shell = { base: p.base, axis, capBottom: false, segments: n };
    sink.frustumShell(m, { ...shell, profile: prof, capTop: !p.openTop });
    sink.frustumShell(m, { ...shell, profile: bore, capTop: !p.openTop, inward: true });
    rim(sink, m, {
      centre: at(bottom.y),
      normal: scale(axis, -1),
      rOut: bottom.r,
      rIn: boreBottom.r,
      n,
    });
    if (p.openTop) {
      rim(sink, m, { centre: at(top.y), normal: axis, rOut: top.r, rIn: boreTop.r, n });
      sink.opening(m, { centre: at(top.y), normal: axis, r: boreTop.r });
    }
  }
  if (p.joints) {
    const spacing = p.joints.spacing;
    const count = Math.ceil((top.y - bottom.y) / spacing);
    if (count > MAX_JOINTS) fail(`shaft joints are too close (over ${String(MAX_JOINTS)} rings)`);
    for (let k = 1; bottom.y + k * spacing < top.y - 1e-9; k++) {
      const h = bottom.y + k * spacing;
      sink.torus('joint', { centre: at(h), axis, R: profileRadiusAt(prof, h), r: JOINT_R });
    }
  }
}

export function buildBand(sink: MeshSink, a: AssemblyOf<'band'>, ctx: BuildCtx): void {
  const b = a.params;
  const s = ctx.model.assemblies.find((x) => x.id === b.shaft);
  if (s?.kind !== 'shaft') fail(`band shaft "${b.shaft}" is not a shaft in the model`);
  const sp = s.params;
  const axis = shaftAxis(sp);
  const h0 = shaftHeightAt(sp, b.y0);
  const h1 = shaftHeightAt(sp, b.y1);
  const [lo, hi] = h0 < h1 ? [h0, h1] : [h1, h0];
  // the band follows any change of taper between its ends
  const hs = [lo, ...sp.profile.map((q) => q.y).filter((y) => y > lo + 1e-9 && y < hi - 1e-9), hi];
  const shaftR = hs.map((h) => ({ y: h, r: profileRadiusAt(sp.profile, h) }));
  const outer = shaftR.map((q) => ({ y: q.y, r: q.r + BAND_PROUD }));
  const inner = shaftR.map((q) => ({ y: q.y, r: q.r - BAND_SINK }));
  if (!inner.every((q) => q.r > 0)) fail('band shaft is too thin for a band');
  const n = sink.segmentsFor(Math.max(...outer.map((q) => q.r)));
  const m = b.material;
  const shell = { base: sp.base, axis, capBottom: false, capTop: false, segments: n };
  sink.frustumShell(m, { ...shell, profile: outer });
  sink.frustumShell(m, { ...shell, profile: inner, inward: true });
  const [o0, o1] = ends(outer, 'band');
  const [i0, i1] = ends(inner, 'band');
  const at = (h: number): V3 => add(sp.base, scale(axis, h));
  rim(sink, m, { centre: at(lo), normal: scale(axis, -1), rOut: o0.r, rIn: i0.r, n });
  rim(sink, m, { centre: at(hi), normal: axis, rOut: o1.r, rIn: i1.r, n });
}

export function buildFlue(sink: MeshSink, a: AssemblyOf<'flue'>, ctx: BuildCtx): void {
  const f = a.params;
  const m = ctx.material(a.material, 'stainless');
  const up: V3 = [0, 1, 0];
  // the mouth is at `centre`; a flue is never capped
  sink.annulusTube(m, {
    centre: f.centre,
    axis: up,
    rOuter: f.rOuter,
    rInner: f.rInner,
    y0: -f.height,
    y1: 0,
    openings: 'top',
  });
  if (f.rim) {
    const R = (f.rOuter + f.rInner) / 2;
    sink.torus(m, {
      centre: f.centre,
      axis: up,
      R,
      r: Math.min(0.625 * (f.rOuter - f.rInner), 0.9 * R),
    });
  }
  if (f.flange) {
    // a collar near the foot (kept clear of the tube's bottom ring) and one at mid height
    const r = 0.06 * f.rOuter;
    for (const y of [-f.height + 2 * r, -f.height / 2])
      sink.torus(m, { centre: add(f.centre, [0, y, 0]), axis: up, R: f.rOuter, r });
  }
}

export function buildFlareTip(sink: MeshSink, a: AssemblyOf<'flareTip'>, ctx: BuildCtx): void {
  const t = a.params;
  const m = ctx.material(a.material, 'stainless');
  const up: V3 = [0, 1, 0];
  const bore = 0.9 * t.r;
  sink.annulusTube(m, {
    centre: t.base,
    axis: up,
    rOuter: t.r,
    rInner: bore,
    y0: 0,
    y1: t.height,
    openings: 'top',
  });
  // refractory lining in the upper part of the bore, flush with the mouth
  sink.annulusTube('refractory', {
    centre: t.base,
    axis: up,
    rOuter: bore,
    rInner: 0.78 * t.r,
    y0: 0.6 * t.height,
    y1: t.height,
    openings: 'top',
  });
  if (t.windshield) {
    // a half cylinder sheet on the +x side, from a quarter of the height to just above the mouth
    const R = 1.3 * t.r;
    const n = Math.max(2, Math.ceil(sink.segmentsFor(R) / 2));
    const p = sink.prim('steel-sheet');
    const y0 = 0.25 * t.height;
    const y1 = 1.15 * t.height;
    const row = (y: number) =>
      Array.from({ length: n + 1 }, (_, k) => {
        const th = -Math.PI / 2 + (Math.PI * k) / n;
        const d: V3 = [Math.cos(th), 0, Math.sin(th)];
        return sink.vertex(p, add(t.base, add(scale(d, R), [0, y, 0])), d);
      });
    const lo = row(y0);
    const hi = row(y1);
    for (let k = 0; k < n; k++)
      sink.quad(p, lo[k] ?? 0, lo[k + 1] ?? 0, hi[k + 1] ?? 0, hi[k] ?? 0);
  }
  const pilots = t.pilots ?? 0;
  for (let k = 0; k < pilots; k++) {
    const th = (2 * Math.PI * (k + 0.5)) / pilots;
    const foot = add(t.base, [
      1.12 * t.r * Math.cos(th),
      0.3 * t.height,
      1.12 * t.r * Math.sin(th),
    ]);
    sink.rod(m, foot, add(foot, [0, 0.8 * t.height, 0]), 0.03 * t.r, true);
  }
}

export function buildDeck(sink: MeshSink, a: AssemblyOf<'deck'>, ctx: BuildCtx): void {
  const d = a.params;
  sink.slab(ctx.material(a.material, 'concrete-grey'), {
    y: d.y,
    outline: d.outline,
    thickness: d.thickness,
    holes: d.openings.map((o) => ({ c: o.centre, r: o.r })),
  });
}

/** A plinth from `y` up `height`. */
export function buildBase(sink: MeshSink, a: AssemblyOf<'base'>, ctx: BuildCtx): void {
  const b = a.params;
  sink.slab(ctx.material(a.material, 'concrete-grey'), {
    y: b.y + b.height,
    outline: b.outline,
    thickness: b.height,
    holes: [],
  });
}

export const SHAFT_BUILDERS = {
  shaft: buildShaft,
  band: buildBand,
  flue: buildFlue,
  flareTip: buildFlareTip,
  deck: buildDeck,
  base: buildBase,
} satisfies BuilderTable;
