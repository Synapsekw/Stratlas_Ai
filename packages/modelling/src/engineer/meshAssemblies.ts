/**
 * Engineering meshing: the assemblies of an `aio.procmodel/2` model turned into one GLB node each
 * (named by the assembly id, one primitive per material, PBR materials, the component record in
 * the node extras), within the triangle budget of the detail level.
 *
 * Each component is built on its own `MeshSink` by the builder of its kind, then made relative to
 * an anchor near it (its `base`, `centre`, `bottom` or first path point, else the middle of its
 * bounds), so float32 vertices keep sub-millimetre precision however far the model is from the
 * origin; the anchor becomes the node translation (float64 in the JSON). Declared openings stay in
 * the model frame and travel in the node extras, so `validateGlb` can check a file on its own.
 */
import {
  DETAIL_BUDGETS,
  type Assembly,
  type AssemblyKind,
  type Detail,
  type Material,
  type ProcModel,
  type ValueBasis,
} from '@aio/schema';
import { writeGlbV2, type GlbMaterial, type GlbNodeV2 } from '../glb';
import { meshParts, partColour } from '../mesher';
import { ACCESS_BUILDERS } from './builders/access';
import { ctxFor, type BuildCtx, type Builder } from './builders/ctx';
import { LIGHT_BUILDERS } from './builders/lights';
import { LINE_BUILDERS } from './builders/lines';
import { SHAFT_BUILDERS } from './builders/shaft';
import { STEEL_BUILDERS } from './builders/steel';
import { TELECOM_BUILDERS } from './builders/telecom';
import { MeshSink, SEGMENTS, type Opening, type Prim, type V3 } from './geom';
import { resolveMaterials } from './materials';

/** The builder of every assembly kind; a kind without one is a type error here. */
export const BUILDERS: { [K in AssemblyKind]: Builder<K> } = {
  ...SHAFT_BUILDERS,
  ...ACCESS_BUILDERS,
  ...LINE_BUILDERS,
  ...STEEL_BUILDERS,
  ...TELECOM_BUILDERS,
  ...LIGHT_BUILDERS,
};

/** Builds assembly `a` onto `sink` with the builder of its kind. */
export function buildAssembly(sink: MeshSink, a: Assembly, ctx: BuildCtx): void {
  (BUILDERS[a.kind] as unknown as Builder<AssemblyKind>)(sink, a, ctx);
}

/** One meshed component: primitives relative to `anchor` (model frame), openings in the model frame. */
export interface ComponentMesh {
  id: string;
  prims: Prim[];
  anchor: V3;
  triangles: number;
  /** Declared intended openings (model frame); empty when there are none. */
  openings: Opening[];
  /** The detail level this component was meshed at. */
  detail: Detail;
}

export interface MeshAssembliesResult {
  components: ComponentMesh[];
  triangles: number;
  /** Still over the budget after every component was coarsened to `fast`. */
  overBudget: boolean;
  /** The coarsest detail level used (the requested one unless the budget forced a fallback). */
  detail: Detail;
  /** Components meshed below the requested detail to meet the budget, in the order coarsened. */
  simplified: { id: string; detail: Detail }[];
  /** Components whose geometry could not be built (not written), with the reason. */
  failed: { id: string; reason: string }[];
}

const LEVELS: readonly Detail[] = ['detailed', 'standard', 'fast'];

const trianglesOf = (prims: readonly Prim[]) => prims.reduce((s, p) => s + p.indices.length / 3, 0);

function boundsOf(prims: readonly Prim[]): { min: V3; max: V3 } | null {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of prims)
    for (let i = 0; i + 2 < p.positions.length; i += 3)
      for (const k of [0, 1, 2] as const) {
        const v = p.positions[i + k] ?? 0;
        min[k] = Math.min(min[k], v);
        max[k] = Math.max(max[k], v);
      }
  return min[0] <= max[0] ? { min, max } : null;
}

/** Diagonal of the bounds: how large (and so how visible) a component is. */
function sizeOf(prims: readonly Prim[]): number {
  const b = boundsOf(prims);
  return b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 0;
}

const isV3 = (v: unknown): v is V3 =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The node anchor of a component: the first of its `base`, `centre`, `bottom` or `path[0]`
 * params, else the middle of its bounds (to the millimetre), else the origin.
 */
export function anchorOf(a: Assembly, prims: readonly Prim[]): V3 {
  const p = a.params as Record<string, unknown>;
  for (const key of ['base', 'centre', 'bottom']) {
    const v = p[key];
    if (isV3(v)) return [v[0], v[1], v[2]];
  }
  const path = p.path;
  if (Array.isArray(path) && isV3(path[0])) return [path[0][0], path[0][1], path[0][2]];
  const b = boundsOf(prims);
  if (!b) return [0, 0, 0];
  const mid = (k: 0 | 1 | 2) => Math.round(((b.min[k] + b.max[k]) / 2) * 1000) / 1000;
  return [mid(0), mid(1), mid(2)];
}

/**
 * Meshes the assemblies `o.include` accepts at `o.detail`. When the total exceeds the budget
 * (`DETAIL_BUDGETS[detail].triangles` unless `o.budget` is given), components are coarsened one
 * detail level at a time, the smallest (least visible) first, until the total fits or everything
 * is at `fast`. Nothing is dropped for the budget: coarsened components are listed in
 * `simplified`, and a component whose geometry fails to build is listed in `failed`.
 */
export function meshAssemblies(
  model: ProcModel,
  o: { detail: Detail; include: (a: Assembly) => boolean; budget?: number },
): MeshAssembliesResult {
  const ctx = ctxFor(model);
  const meshAt = (a: Assembly, d: Detail): Prim[] => {
    const sink = new MeshSink(SEGMENTS[d]);
    buildAssembly(sink, a, ctx);
    return sink.out();
  };
  const start = LEVELS.indexOf(o.detail);
  const failed: { id: string; reason: string }[] = [];
  const entries: { a: Assembly; prims: Prim[]; level: number; size: number }[] = [];
  for (const a of model.assemblies) {
    if (!o.include(a)) continue;
    try {
      const prims = meshAt(a, o.detail);
      entries.push({ a, prims, level: start, size: sizeOf(prims) });
    } catch (e) {
      failed.push({ id: a.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const budget = o.budget ?? DETAIL_BUDGETS[o.detail].triangles;
  let total = entries.reduce((s, e) => s + trianglesOf(e.prims), 0);
  const simplified: { id: string; detail: Detail }[] = [];
  if (total > budget) {
    const order = [...entries].sort((x, y) => x.size - y.size || x.a.id.localeCompare(y.a.id));
    for (let lv = start + 1; lv < LEVELS.length && total > budget; lv++) {
      const d = LEVELS[lv] ?? 'fast';
      for (const e of order) {
        if (total <= budget) break;
        let prims: Prim[];
        try {
          prims = meshAt(e.a, d);
        } catch {
          continue; // keep the finer mesh that did build
        }
        total += trianglesOf(prims) - trianglesOf(e.prims);
        e.prims = prims;
        e.level = lv;
        const row = simplified.find((s) => s.id === e.a.id);
        if (row) row.detail = d;
        else simplified.push({ id: e.a.id, detail: d });
      }
    }
  }
  const components = entries.map((e): ComponentMesh => {
    const anchor = anchorOf(e.a, e.prims);
    return {
      id: e.a.id,
      anchor,
      triangles: trianglesOf(e.prims),
      openings: e.prims.flatMap((p) => p.openings ?? []),
      detail: LEVELS[e.level] ?? o.detail,
      prims: e.prims
        .filter((p) => p.indices.length > 0)
        .map((p) => ({
          material: p.material,
          positions: p.positions.map((v, i) => v - anchor[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2]),
          normals: p.normals,
          indices: p.indices,
        })),
    };
  });
  const coarsest = Math.max(start, ...entries.map((e) => e.level));
  return {
    components,
    triangles: total,
    overBudget: total > budget,
    detail: LEVELS[coarsest] ?? o.detail,
    simplified,
    failed,
  };
}

/** Basis order for ties: the weaker basis wins, so a label never overstates. */
const BASIS_RANK: Record<ValueBasis, number> = { inferred: 0, observed: 1, user: 2, measured: 3 };

/**
 * The component record for GLB node extras: identity and description, the most common value
 * basis (`inferred` when nothing is recorded), and the quality summarised to the basis of each
 * parameter, the worst residual and the least coverage. `part` (the id) and an optional `tag`
 * and `type` keep the extras keys `/1` part nodes have.
 */
export function componentExtras(a: Assembly): Record<string, unknown> {
  const params: Record<string, ValueBasis> = {};
  const counts = new Map<ValueBasis, number>();
  let residualM: number | undefined;
  let coverage: number | undefined;
  for (const [key, q] of Object.entries(a.quality)) {
    params[key] = q.basis;
    counts.set(q.basis, (counts.get(q.basis) ?? 0) + 1);
    if (q.residualM !== undefined) residualM = Math.max(residualM ?? 0, q.residualM);
    if (q.coverage !== undefined) coverage = Math.min(coverage ?? 1, q.coverage);
  }
  let basis: ValueBasis = 'inferred';
  let best = 0;
  for (const [b, n] of counts)
    if (n > best || (n === best && BASIS_RANK[b] < BASIS_RANK[basis])) {
      basis = b;
      best = n;
    }
  return {
    component: a.id,
    name: a.name,
    description: a.description,
    category: a.category,
    kind: a.kind,
    status: a.status,
    ...(a.tag === undefined ? {} : { tag: a.tag }),
    ...(a.type === undefined ? {} : { type: a.type }),
    ...(a.parent === undefined ? {} : { parent: a.parent }),
    part: a.id,
    basis,
    ...(a.unobserved === undefined ? {} : { unobserved: [...a.unobserved] }),
    quality: {
      params,
      ...(residualM === undefined ? {} : { residualM }),
      ...(coverage === undefined ? {} : { coverage }),
    },
  };
}

const toGlbMaterial = (m: Material): GlbMaterial => ({
  name: m.id,
  baseColor: m.baseColor,
  metallic: m.metallic,
  roughness: m.roughness,
  ...(m.emissive ? { emissive: m.emissive } : {}),
  ...(m.doubleSided ? { doubleSided: true } : {}),
});

export interface EngineeringGlb {
  glb: Uint8Array;
  /** Every node written (assemblies, then `/1` parts) with its tag when it has one. */
  nodes: { node: string; tag?: string; area?: string }[];
  triangles: number;
  overBudget: boolean;
  /** The coarsest detail level used. */
  detail: Detail;
  simplified: { id: string; detail: Detail }[];
  failed: { id: string; reason: string }[];
}

/**
 * The engineering GLB of a model: a root node named by the model id holding one node per accepted
 * assembly (and draft ones when `drafts`; rejected ones never), then one node per `/1` part (the
 * same parts the parts mesher writes, in a matte class colour; a part whose node name an assembly
 * id already has gets its part id added). Only the materials in use are written.
 */
export function buildEngineeringGlb(
  model: ProcModel,
  o: { detail: Detail; drafts: boolean; generator: string; budget?: number },
): EngineeringGlb {
  const r = meshAssemblies(model, {
    detail: o.detail,
    include: (a) => a.status === 'accepted' || (o.drafts && a.status === 'draft'),
    ...(o.budget === undefined ? {} : { budget: o.budget }),
  });
  const known = new Map(resolveMaterials(model).map((m) => [m.id, m]));
  const materials: GlbMaterial[] = [];
  const index = new Map<string, number>();
  const materialIndex = (name: string, make: () => GlbMaterial | undefined): number => {
    const at = index.get(name);
    if (at !== undefined) return at;
    const m = make();
    if (!m) throw new Error(`engineering model: material "${name}" is not defined`);
    index.set(name, materials.push(m) - 1);
    return materials.length - 1;
  };
  const byId = new Map(model.assemblies.map((a) => [a.id, a]));
  const nodes: GlbNodeV2[] = [];
  const list: EngineeringGlb['nodes'] = [];
  for (const c of r.components) {
    const a = byId.get(c.id);
    if (!a) continue;
    nodes.push({
      name: c.id,
      translation: c.anchor,
      extras: {
        ...componentExtras(a),
        ...(c.openings.length ? { openings: c.openings } : {}),
      },
      primitives: c.prims.map((p) => ({
        material: materialIndex(p.material, () => {
          const m = known.get(p.material);
          return m && toGlbMaterial(m);
        }),
        positions: Float32Array.from(p.positions),
        normals: Float32Array.from(p.normals),
        indices: Uint32Array.from(p.indices),
      })),
    });
    list.push(a.tag === undefined ? { node: c.id } : { node: c.id, tag: a.tag });
  }
  let triangles = r.triangles;
  const used = new Set(r.components.map((c) => c.id));
  for (const { part, name, extras, mesh } of meshParts(model, {
    parts: o.drafts ? 'all' : 'accepted',
    used,
  })) {
    const colour = partColour(part);
    const material = materialIndex(colour.name, () => ({
      name: colour.name,
      baseColor: [...colour.rgb, 1],
      metallic: 0,
      roughness: 0.85,
    }));
    nodes.push({
      name,
      translation: mesh.translation,
      extras,
      primitives: [
        { material, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices },
      ],
    });
    triangles += mesh.indices.length / 3;
    list.push(extras.tag === undefined ? { node: name } : { node: name, tag: extras.tag });
  }
  const budget = o.budget ?? DETAIL_BUDGETS[o.detail].triangles;
  return {
    glb: writeGlbV2(nodes, { root: model.id, generator: o.generator, materials }),
    nodes: list,
    triangles,
    overBudget: r.overBudget || triangles > budget,
    detail: r.detail,
    simplified: r.simplified,
    failed: r.failed,
  };
}
