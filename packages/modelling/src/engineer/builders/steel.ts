/**
 * Builders of structural steel: lattice tower sections, portal and rack frames, and equipment
 * cabinets. Every member is its own closed solid (round bars for lattice legs, square `beam`s
 * for the rest), so members cost the same few triangles at every detail level and a lattice of
 * the most bays the schema allows stays well inside the triangle budget.
 *
 * Default materials (ids `DEFAULT_MATERIALS` carries): lattice and frame `steel-galv`, cabinet
 * `cabinet-grey`. The assembly `material` overrides them.
 */
import type { AssemblyParams } from '@aio/schema';
import { add, cross, norm, scale, sub, type MeshSink, type V3 } from '../geom';
import type { AssemblyOf, BuildCtx, BuilderTable } from './ctx';

function fail(what: string): never {
  throw new Error(`geometry: ${what}`);
}

function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i];
  if (v === undefined) fail(`index ${String(i)} is out of range`);
  return v;
}

// -- lattice -----------------------------------------------------------------------------------

/** Plan angle (degrees, from +X towards +Z) of each leg of a three-leg lattice. */
const LEG_ANGLES = { 3: [90, 210, 330] } as const;

/** Braces per face in one bay: X two crossing diagonals, K two half diagonals, Z one diagonal. */
const BRACES_PER_FACE = { X: 2, K: 2, Z: 1 } as const;

/** Diagonal braces of a lattice (horizontals not included): faces x bays x braces per face. */
export function braceCount(p: {
  legs: number;
  bays: readonly { bracing: keyof typeof BRACES_PER_FACE }[];
}): number {
  return p.bays.reduce((n, b) => n + p.legs * BRACES_PER_FACE[b.bracing], 0);
}

/**
 * The leg centre points of a lattice at world height `y` (clamped to the lattice). The face width
 * (spacing of neighbouring legs) runs linearly from `widthBase` at the base to `widthTop` at
 * `height`; legs stand at 45, 135, 225 and 315 degrees (four legs) or 90, 210 and 330 (three),
 * measured in plan from +X towards +Z round the base point.
 */
export function latticeLegAt(p: AssemblyParams<'lattice'>, y: number): V3[] {
  const h = Math.max(0, Math.min(p.height, y - p.base[1]));
  const width = p.widthBase + ((p.widthTop - p.widthBase) * h) / p.height;
  const y0 = p.base[1] + h;
  if (p.legs === 4) {
    // the corners of a square of side `width`, exactly
    const w = width / 2;
    return [
      [w, w],
      [-w, w],
      [-w, -w],
      [w, -w],
    ].map(([dx = 0, dz = 0]) => [p.base[0] + dx, y0, p.base[2] + dz]);
  }
  const r = width / Math.sqrt(3);
  return LEG_ANGLES[3].map((deg) => {
    const t = (deg * Math.PI) / 180;
    return [p.base[0] + r * Math.cos(t), y0, p.base[2] + r * Math.sin(t)];
  });
}

/** Centreline offset of an X's second diagonal, in brace sections (clear of the first). */
const X_OFFSET = 1.1;

/** Horizontal unit vector from the middle of face `i`-`j` of a bay towards the lattice axis. */
function faceInward(p: AssemblyParams<'lattice'>, lo: V3[], hi: V3[], i: number, j: number): V3 {
  const mid = scale(add(add(at(lo, i), at(lo, j)), add(at(hi, i), at(hi, j))), 0.25);
  const toAxis: V3 = [p.base[0] - mid[0], 0, p.base[2] - mid[2]];
  return norm(toAxis);
}

/**
 * Lattice: one round leg per corner from base to top, a horizontal on every face at each bay top
 * and the bay's bracing on every face. X crosses both diagonals of the face; K runs two half
 * diagonals from the far leg's bottom and top to the near leg at mid-height of the bay (the K of
 * the letter); Z is one diagonal, alternating its direction from bay to bay.
 */
export function buildLattice(sink: MeshSink, a: AssemblyOf<'lattice'>, ctx: BuildCtx): void {
  const p = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  if (p.braceSection > p.legSection) fail('lattice braces cannot be thicker than its legs');
  const total = p.bays.reduce((s, b) => s + b.height, 0);
  if (total > p.height * (1 + 1e-9) + 1e-6)
    fail(
      `lattice bays add up to ${String(total)} m, taller than the lattice (${String(p.height)} m)`,
    );
  const legsAt = (h: number) => latticeLegAt(p, p.base[1] + h);
  const bottom = legsAt(0);
  const top = legsAt(p.height);
  bottom.forEach((b, i) => {
    sink.rod(m, b, at(top, i), p.legSection / 2, true);
  });
  const n = p.legs;
  let h0 = 0;
  p.bays.forEach((bay, k) => {
    const h1 = h0 + bay.height;
    const lo = legsAt(h0);
    const mid = legsAt((h0 + h1) / 2);
    const hi = legsAt(h1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      sink.beam(m, at(hi, i), at(hi, j), p.braceSection);
      if (bay.bracing === 'X') {
        // bolted back to back: the second diagonal sits clear inside the first, so the two
        // never share a face plane where they cross
        const inward = faceInward(p, lo, hi, i, j);
        const off = scale(inward, X_OFFSET * p.braceSection);
        sink.beam(m, at(lo, i), at(hi, j), p.braceSection);
        sink.beam(m, add(at(lo, j), off), add(at(hi, i), off), p.braceSection);
      } else if (bay.bracing === 'K') {
        sink.beam(m, at(lo, j), at(mid, i), p.braceSection);
        sink.beam(m, at(hi, j), at(mid, i), p.braceSection);
      } else if (k % 2 === 0) {
        sink.beam(m, at(lo, i), at(hi, j), p.braceSection);
      } else {
        sink.beam(m, at(lo, j), at(hi, i), p.braceSection);
      }
    }
    h0 = h1;
  });
}

// -- frames and cabinets -------------------------------------------------------------------------

/** Plan axes of a yawed object: `x` along its span, `z` its front (counter-clockwise yaw). */
function planAxes(yawDeg: number): { x: V3; z: V3 } {
  const t = (yawDeg * Math.PI) / 180;
  const x: V3 = [Math.cos(t), 0, -Math.sin(t)];
  return { x, z: norm(cross(x, [0, 1, 0])) };
}

/** Beam section as a share of the column section. */
const BEAM_SHARE = 0.9;

/**
 * Frame: `bays + 1` columns spaced along the span (local x, turned by `yawDeg`) round `base`.
 * Portal: one beam across the column tops (just below them); `braced` adds a knee brace at both
 * top corners of every bay. Rack: a beam along the whole span at mid-height and one at the top; `braced` adds
 * one diagonal per bay from a column foot to the mid-height tier, alternating direction;
 * braces run from column face to column face.
 */
export function buildFrame(sink: MeshSink, a: AssemblyOf<'frame'>, ctx: BuildCtx): void {
  const p = a.params;
  const m = ctx.material(a.material, 'steel-galv');
  const { x } = planAxes(p.yawDeg);
  const s = p.member;
  if (s * 2 >= p.span / p.bays) fail('frame members are too thick for the bay width');
  if (s * 2 >= p.height) fail('frame members are too thick for the frame height');
  const foot = (i: number): V3 => add(p.base, scale(x, -p.span / 2 + (p.span * i) / p.bays));
  const up = (q: V3, h: number): V3 => [q[0], q[1] + h, q[2]];
  for (let i = 0; i <= p.bays; i++) {
    const f = foot(i);
    sink.box(m, { centre: up(f, p.height / 2), size: [s, p.height, s], yawDeg: p.yawDeg });
  }
  // beams a little slimmer than the columns, so no beam face lies in a column face at a joint
  const beamAt = (h: number, i0: number, i1: number) => {
    sink.beam(m, up(foot(i0), h), up(foot(i1), h), s * BEAM_SHARE);
  };
  if (p.kind === 'portal') {
    const hb = p.height - s / 2;
    beamAt(hb, 0, p.bays);
    if (!p.braced) return;
    const knee = Math.min(p.span / p.bays, p.height) / 4;
    for (let i = 0; i < p.bays; i++) {
      const a0 = foot(i);
      const a1 = foot(i + 1);
      const dir = norm(sub(a1, a0));
      // braces start on the column faces, so the two meeting a middle column stay apart
      const half = scale(dir, s / 2);
      sink.beam(m, up(add(a0, half), hb - knee), up(add(a0, scale(dir, knee)), hb), s * 0.7);
      sink.beam(m, up(sub(a1, half), hb - knee), up(sub(a1, scale(dir, knee)), hb), s * 0.7);
    }
    return;
  }
  // one continuous beam per tier: beams meeting end to end on a column would weld into one
  for (const h of [p.height / 2, p.height - s / 2]) beamAt(h, 0, p.bays);
  for (let i = 0; i < p.bays; i++) {
    if (p.braced) {
      const [f0, f1] = i % 2 === 0 ? [i, i + 1] : [i + 1, i];
      // from column face to column face, so diagonals meeting one column stay apart
      const half = scale(norm(sub(foot(f1), foot(f0))), s / 2);
      sink.beam(m, up(add(foot(f0), half), s), up(sub(foot(f1), half), p.height / 2), s * 0.7);
    }
  }
}

/** How far the door leaves stand proud of the cabinet front, and the seam between them. */
const DOOR_PROUD = 0.01;
const DOOR_EMBED = 0.002;

/**
 * Cabinet: a box standing on `base` (centre of its bottom), `size` = width, height, depth, turned
 * by `yawDeg`, with two door leaves on its front (local +z) split by a vertical seam and inset
 * from the edges.
 */
export function buildCabinet(sink: MeshSink, a: AssemblyOf<'cabinet'>, ctx: BuildCtx): void {
  const p = a.params;
  const m = ctx.material(a.material, 'cabinet-grey');
  const [w, h, d] = p.size;
  const { x, z } = planAxes(p.yawDeg);
  const centre: V3 = [p.base[0], p.base[1] + h / 2, p.base[2]];
  sink.box(m, { centre, size: [w, h, d], yawDeg: p.yawDeg });
  const inset = Math.min(w, h) * 0.04;
  const seam = Math.min(0.01, w * 0.02);
  const leafW = (w - 2 * inset - seam) / 2;
  const leafH = h - 2 * inset;
  if (!(leafW > 0 && leafH > 0)) fail('cabinet is too small for its doors');
  const t = DOOR_PROUD + DOOR_EMBED;
  const face = add(centre, scale(z, d / 2 + DOOR_PROUD - t / 2));
  for (const side of [-1, 1]) {
    const c = add(face, scale(x, side * (seam / 2 + leafW / 2)));
    sink.box(m, { centre: c, size: [leafW, leafH, t], yawDeg: p.yawDeg });
  }
}

export const STEEL_BUILDERS = {
  lattice: buildLattice,
  frame: buildFrame,
  cabinet: buildCabinet,
} satisfies BuilderTable;
