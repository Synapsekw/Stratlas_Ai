/**
 * Builder of aviation warning lights. A light is one component (one assembly) whose mount
 * bracket, housing and lens are separate primitives: the bracket `steel-galv`, the housing
 * `lamp-housing` (or the assembly `material`), the lens always `lamp-lens-red`, the emissive
 * material `DEFAULT_MATERIALS` carries, so the lens glows whatever the housing is painted.
 *
 * `centre` is where the bracket leaves the shaft or leg surface, `outward` the way it points
 * (any direction, straight up for a lamp on top), `size` the housing diameter. The housing and
 * lens stand upright at the bracket's end.
 */
import { add, cross, len, norm, scale, type MeshSink, type V3 } from '../geom';
import type { AssemblyOf, BuildCtx, BuilderTable } from './ctx';

const UP: V3 = [0, 1, 0];
/** How far the bracket starts inside the surface it hangs from, so no gap shows. */
const BRACKET_EMBED = 0.02;

/** A capped upright cylinder of radius `r` from `foot` up `h`. */
function cylinder(sink: MeshSink, m: string, foot: V3, r: number, h: number): void {
  sink.rod(m, foot, add(foot, scale(UP, h)), r, true);
}

/** A hemisphere of radius `r` standing on `foot`, its flat side down. */
function dome(sink: MeshSink, m: string, foot: V3, r: number): void {
  const steps = 8;
  sink.frustumShell(m, {
    base: foot,
    axis: UP,
    profile: Array.from({ length: steps + 1 }, (_, i) => {
      const t = (i / steps) * (Math.PI / 2);
      return { y: r * Math.sin(t), r: i === steps ? 0 : r * Math.cos(t) };
    }),
    capBottom: true,
    capTop: false,
  });
}

export function buildWarningLight(
  sink: MeshSink,
  a: AssemblyOf<'warningLight'>,
  ctx: BuildCtx,
): void {
  const p = a.params;
  if (!(len(p.outward) > 1e-9)) throw new Error('geometry: warning light outward cannot be zero');
  const out = norm(p.outward);
  const s = p.size;
  const housingM = ctx.material(a.material, 'lamp-housing');
  const lensM = 'lamp-lens-red';
  // bracket: a square bar from inside the surface out to under the housing centre
  const bar = s * 0.15;
  const end = add(p.centre, scale(out, s));
  sink.beam('steel-galv', add(p.centre, scale(out, -BRACKET_EMBED)), end, bar);
  // housing: a short cylinder standing on the bracket (on its top face when the bracket runs
  // sideways, on its end when it stands straight up)
  const foot = add(end, scale(UP, (bar / 2) * Math.hypot(out[0], out[2])));
  const hh = s * 0.3;
  cylinder(sink, housingM, foot, s / 2, hh);
  const top = add(foot, scale(UP, hh));
  switch (p.fixture) {
    case 'single':
      cylinder(sink, lensM, top, s * 0.35, s * 0.35);
      return;
    case 'twin': {
      // side by side across the outward direction, clear of each other
      let side = cross(UP, out);
      if (len(side) < 1e-6) side = [1, 0, 0];
      side = norm(side);
      for (const k of [-1, 1])
        cylinder(sink, lensM, add(top, scale(side, k * s * 0.22)), s * 0.2, s * 0.35);
      return;
    }
    case 'canister': {
      const lensH = s;
      cylinder(sink, lensM, top, s * 0.35, lensH);
      cylinder(sink, housingM, add(top, scale(UP, lensH)), s / 2, s * 0.1);
      return;
    }
    case 'beacon':
      dome(sink, lensM, top, s * 0.4);
      return;
  }
}

export const LIGHT_BUILDERS = { warningLight: buildWarningLight } satisfies BuilderTable;
