/**
 * Test fixtures for the engineering assembly builders: small models, assembly helpers and a
 * test-only builder registry so `build(kind, params)` and `sinkFor(model, id)` reach any kind.
 * The shaft family registers itself here; other builder tests call `registerBuilders(TABLE)` with
 * their own file's table before using `build` or `sinkFor`.
 */
import type { Assembly, AssemblyKind, AssemblyParams, ProcModel } from '@aio/schema';
import { MeshSink, SEGMENTS, type Prim } from '../geom';
import { componentVolumes, vertexAt } from '../testGeom';
import { newProcModel } from '../../procmodel';
import { ctxFor, type AssemblyOf, type Builder, type BuilderTable } from './ctx';
import { SHAFT_BUILDERS } from './shaft';

const registry: BuilderTable = { ...SHAFT_BUILDERS };

/** Makes the builders of `table` reachable from `build` and `sinkFor`. */
export function registerBuilders(table: BuilderTable): void {
  Object.assign(registry, table);
}

/** An assembly of `kind` with `params` and neutral metadata. */
export function assembly<K extends AssemblyKind>(
  kind: K,
  id: string,
  params: AssemblyParams<K>,
  extra: { material?: string; parent?: string } = {},
): AssemblyOf<K> {
  const a = {
    id,
    kind,
    params,
    name: id,
    description: '',
    category: kind,
    status: 'draft',
    origin: { by: 'manual' },
    quality: {},
    sources: [],
    ...extra,
  };
  return a as unknown as AssemblyOf<K>;
}

/** A procmodel/2 holding `assemblies`. */
export function model(assemblies: Assembly[]): ProcModel {
  return {
    ...newProcModel({ id: 'model-test', name: 'Test', now: '2026-10-15T00:00:00.000Z' }),
    assemblies,
  };
}

/** A shaft on the origin, axis up. */
export function shaft(
  id: string,
  profile: { y: number; r: number }[],
  o: {
    wall?: number;
    openTop?: boolean;
    joints?: { spacing: number };
    base?: [number, number, number];
    axis?: [number, number, number];
  } = {},
): AssemblyOf<'shaft'> {
  const { openTop = false, base = [0, 0, 0], ...rest } = o;
  return assembly('shaft', id, { base, profile, openTop, ...rest });
}

/**
 * Flue `i` (1-based) of `n` on a circle of radius 2.5 about the origin, mouth at y 103, 8 m
 * tall, outer radius 1 and inner 0.9.
 */
export function flue(
  id: string,
  i: number,
  n = 4,
  o: { rim?: boolean; flange?: boolean } = {},
): AssemblyOf<'flue'> {
  const t = (2 * Math.PI * (i - 1)) / n;
  return assembly('flue', id, {
    centre: [2.5 * Math.cos(t), 103, 2.5 * Math.sin(t)],
    rOuter: 1,
    rInner: 0.9,
    height: 8,
    ...o,
  });
}

/** A band round `shaftId` between `y0` and `y1`. */
export function band(
  id: string,
  shaftId: string,
  y0: number,
  y1: number,
  material = 'paint-red',
): AssemblyOf<'band'> {
  return assembly('band', id, { shaft: shaftId, y0, y1, material });
}

function builderFor(kind: AssemblyKind): Builder<AssemblyKind> {
  const b = registry[kind] as unknown as Builder<AssemblyKind> | undefined;
  if (!b) throw new Error(`no builder registered for "${kind}" (call registerBuilders first)`);
  return b;
}

/** Builds assembly `id` of `m` at `detail` and returns its sink. */
export function sinkFor(
  m: ProcModel,
  id: string,
  detail: keyof typeof SEGMENTS = 'standard',
): MeshSink {
  const a = m.assemblies.find((x) => x.id === id);
  if (!a) throw new Error(`no assembly "${id}" in the test model`);
  const sink = new MeshSink(SEGMENTS[detail]);
  builderFor(a.kind)(sink, a, ctxFor(m));
  return sink;
}

/**
 * Builds one assembly of `kind` from `params` (id `<kind>-1` unless given) in a model that also
 * holds `with` (a shaft for things placed on one), and returns its sink.
 */
export function build<K extends AssemblyKind>(
  kind: K,
  params: AssemblyParams<K>,
  o: {
    id?: string;
    with?: Assembly[];
    material?: string;
    detail?: keyof typeof SEGMENTS;
  } = {},
): MeshSink {
  const id = o.id ?? `${kind.toLowerCase()}-1`;
  const a = assembly(kind, id, params, o.material === undefined ? {} : { material: o.material });
  return sinkFor(model([...(o.with ?? []), a]), id, o.detail);
}

/** Connected pieces of a primitive (triangles joined through shared positions). */
export function countComponents(p: Prim): number {
  return componentVolumes(p).length;
}

/**
 * The largest distance from the vertical line through (`cx`, `cz`) at which the mesh crosses
 * each height in `ys`: the outer radius of a ring-shaped mesh there. Vertical and quad edges of
 * a surface of revolution meet the height at the true radius, so the maximum is exact.
 */
export function ringRadiiAt(p: Prim, ys: number[], cx = 0, cz = 0): number[] {
  return ys.map((y) => {
    let best = -Infinity;
    const at = (x: number, z: number) => {
      best = Math.max(best, Math.hypot(x - cx, z - cz));
    };
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = vertexAt(p, p.indices[t + e] ?? 0);
        const b = vertexAt(p, p.indices[t + ((e + 1) % 3)] ?? 0);
        if (Math.abs(a[1] - y) < 1e-9) at(a[0], a[2]);
        if ((a[1] - y) * (b[1] - y) < 0) {
          const s = (y - a[1]) / (b[1] - a[1]);
          at(a[0] + s * (b[0] - a[0]), a[2] + s * (b[2] - a[2]));
        }
      }
    }
    if (best === -Infinity) throw new Error(`the mesh does not reach height ${String(y)}`);
    return best;
  });
}
