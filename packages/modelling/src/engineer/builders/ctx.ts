/**
 * Shared context of the engineering assembly builders. A builder turns one assembly into
 * triangles on a `MeshSink`; it reads the rest of the model only through `BuildCtx` (the shaft
 * radius at a height, the material to use).
 *
 * Builder files export a partial table (`SHAFT_BUILDERS`, ...) typed with `satisfies
 * BuilderTable`; the mesher merges the tables into one complete `{ [K in AssemblyKind]:
 * Builder<K> }`, so a kind without a builder is a type error there.
 */
import type { Assembly, AssemblyKind, AssemblyParams, ProcModel } from '@aio/schema';
import { norm, type MeshSink, type V3 } from '../geom';

export type AssemblyOf<K extends AssemblyKind> = Extract<Assembly, { kind: K }>;

export interface BuildCtx {
  model: ProcModel;
  /** Outer radius of shaft `shaftId` at world height `y` (clamped to the profile ends). */
  radiusAt(shaftId: string, y: number): number;
  /** The assembly's own material when it names one, else `fallback`. */
  material(id: string | undefined, fallback: string): string;
}

export type Builder<K extends AssemblyKind> = (
  sink: MeshSink,
  a: AssemblyOf<K>,
  ctx: BuildCtx,
) => void;

/** Builders of some kinds; each builder file exports one of these. */
export type BuilderTable = { [K in AssemblyKind]?: Builder<K> };

/** Unit axis of a shaft (default up). */
export function shaftAxis(p: AssemblyParams<'shaft'>): V3 {
  return norm(p.axis ?? [0, 1, 0]);
}

/** Height along the shaft axis from its base at world height `y`. */
export function shaftHeightAt(p: AssemblyParams<'shaft'>, y: number): number {
  const a = shaftAxis(p);
  const dy = y - p.base[1];
  return Math.abs(a[1]) > 1e-6 ? dy / a[1] : dy;
}

/** Radius of a profile at height `h` along its axis: linear between points, clamped at the ends. */
export function profileRadiusAt(profile: readonly { y: number; r: number }[], h: number): number {
  const first = profile[0];
  const last = profile.at(-1);
  if (!first || !last) throw new Error('geometry: profile needs points');
  if (h <= first.y) return first.r;
  if (h >= last.y) return last.r;
  for (let i = 1; i < profile.length; i++) {
    const q0 = profile[i - 1];
    const q1 = profile[i];
    if (!q0 || !q1 || h > q1.y) continue;
    const t = q1.y > q0.y ? (h - q0.y) / (q1.y - q0.y) : 1;
    return q0.r + t * (q1.r - q0.r);
  }
  return last.r;
}

/** The context for building the assemblies of `model`. */
export function ctxFor(model: ProcModel): BuildCtx {
  return {
    model,
    radiusAt(shaftId, y) {
      const s = model.assemblies.find((a) => a.id === shaftId);
      if (s?.kind !== 'shaft') throw new Error(`geometry: there is no shaft "${shaftId}"`);
      return profileRadiusAt(s.params.profile, shaftHeightAt(s.params, y));
    },
    material: (id, fallback) => id ?? fallback,
  };
}
