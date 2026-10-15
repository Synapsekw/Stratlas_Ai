/**
 * Builder of aviation warning lights. A light is one component (one assembly) whose mount
 * bracket, housing and lens are separate primitives: the bracket `steel-galv`, the housing
 * `lamp-housing` (or the assembly `material`), the lens always `lamp-lens-red`, the emissive
 * material `DEFAULT_MATERIALS` carries, so the lens glows whatever the housing is painted.
 *
 * `centre` is the centre of the lens (the middle of its bounds; for a twin, between the two
 * lenses), `outward` the way the lamp stands off its host (any direction, straight up for a lamp
 * on top), `size` the housing diameter. The lens stands upright on the housing; the bracket runs
 * from under the housing back along `-outward` for `size`, to the host surface at
 * `warningLightSurface(params)`, and starts 2 cm inside it so no gap shows.
 */
import type { AssemblyParams } from '@aio/schema';
import { add, cross, len, norm, scale, type MeshSink, type V3 } from '../geom';
import type { AssemblyOf, BuildCtx, BuilderTable } from './ctx';

const UP: V3 = [0, 1, 0];
/** How far the bracket starts inside the surface it hangs from, so no gap shows. */
const BRACKET_EMBED = 0.02;
/** Lens height of each fixture, in housing diameters. */
const LENS_H = { single: 0.35, twin: 0.35, canister: 1, beacon: 0.4 } as const;
/** Housing height and bracket section, in housing diameters. */
const HOUSING_H = 0.3;
const BAR = 0.15;

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

interface LightLayout {
  out: V3;
  /** Bottom centres of the lens and the housing. */
  lensFoot: V3;
  housingFoot: V3;
  /** The bracket's outer end, under the housing. */
  bracketEnd: V3;
  /** Where the bracket meets the host surface. */
  surface: V3;
}

function layout(p: AssemblyParams<'warningLight'>): LightLayout {
  if (!(len(p.outward) > 1e-9)) throw new Error('geometry: warning light outward cannot be zero');
  const out = norm(p.outward);
  const s = p.size;
  const lensFoot = add(p.centre, scale(UP, (-LENS_H[p.fixture] * s) / 2));
  const housingFoot = add(lensFoot, scale(UP, -HOUSING_H * s));
  // the housing stands on the bracket's top face when it runs sideways, on its end when upright
  const bracketEnd = add(housingFoot, scale(UP, ((-BAR * s) / 2) * Math.hypot(out[0], out[2])));
  return { out, lensFoot, housingFoot, bracketEnd, surface: add(bracketEnd, scale(out, -s)) };
}

/** The point on the host surface the bracket of a light starts from (`centre` is the lens). */
export function warningLightSurface(p: AssemblyParams<'warningLight'>): V3 {
  return layout(p).surface;
}

export function buildWarningLight(
  sink: MeshSink,
  a: AssemblyOf<'warningLight'>,
  ctx: BuildCtx,
): void {
  const p = a.params;
  const { out, lensFoot, housingFoot, bracketEnd, surface } = layout(p);
  const s = p.size;
  const housingM = ctx.material(a.material, 'lamp-housing');
  const lensM = 'lamp-lens-red';
  const lensH = LENS_H[p.fixture] * s;
  sink.beam('steel-galv', add(surface, scale(out, -BRACKET_EMBED)), bracketEnd, BAR * s);
  cylinder(sink, housingM, housingFoot, s / 2, HOUSING_H * s);
  switch (p.fixture) {
    case 'single':
      cylinder(sink, lensM, lensFoot, s * 0.35, lensH);
      return;
    case 'twin': {
      // side by side across the outward direction, clear of each other
      let side = cross(UP, out);
      if (len(side) < 1e-6) side = [1, 0, 0];
      side = norm(side);
      for (const k of [-1, 1])
        cylinder(sink, lensM, add(lensFoot, scale(side, k * s * 0.22)), s * 0.2, lensH);
      return;
    }
    case 'canister':
      cylinder(sink, lensM, lensFoot, s * 0.35, lensH);
      cylinder(sink, housingM, add(lensFoot, scale(UP, lensH)), s / 2, s * 0.1);
      return;
    case 'beacon':
      dome(sink, lensM, lensFoot, lensH);
      return;
  }
}

export const LIGHT_BUILDERS = { warningLight: buildWarningLight } satisfies BuilderTable;
