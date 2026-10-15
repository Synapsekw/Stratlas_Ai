/**
 * File checks of a generated GLB (spec 7, test G), run on the bytes alone: the Khronos glTF
 * validator (passed in, since the app does not ship it), then per node finiteness, index range,
 * unit normals, zero-area and duplicate triangles, holes and intended openings, and the triangle
 * budget.
 *
 * Holes: the triangles of a node (all its primitives but those in a `doubleSided` material, which
 * are single-skin sheets by design) are welded at 0.1 mm and their boundary loops found. A loop
 * matching a declared opening (centroid within 2 cm of its centre and mean radius within 2 percent
 * of `r`, or for an outline every point within 2 cm of it) is intended; any other loop is an
 * unintended hole. Openings: no triangle of the node may cross a declared opening's interior (the
 * disc of 0.95 `r`, or the outline less a small margin), so a capped flue fails while the flue's
 * own rim ring, lying in the opening plane outside the bore, passes; of coplanar circular openings
 * one inside another (a lined bore) only the innermost has to stay clear. Openings come from the node
 * extras (`openings`, model frame) unless `o.openings` gives them for that node.
 */
import { readGlb } from '../glb';
import { basis, cross, dot, len, norm, sub, type Opening, type V3 } from './geom';

export interface KhronosResult {
  errors: number;
  warnings: number;
  /** The error and warning messages, one line each. */
  messages: string[];
}
/** Runs the Khronos glTF validator on GLB bytes. */
export type KhronosValidator = (glb: Uint8Array) => Promise<KhronosResult>;

export interface GlbReport {
  validatorErrors: number;
  validatorWarnings: number;
  messages: string[];
  finite: boolean;
  indicesValid: boolean;
  normalsUnit: boolean;
  degenerate: number;
  duplicateTris: number;
  unintendedHoles: { node: string; loops: number }[];
  intendedOpenOk: boolean;
  triangles: number;
  withinBudget: boolean;
}

interface JsonNode {
  name?: string;
  mesh?: number;
  translation?: number[];
  children?: number[];
  extras?: Record<string, unknown>;
}
interface JsonPrimitive {
  attributes: Record<string, number | undefined>;
  indices?: number;
  material?: number;
  mode?: number;
}
interface JsonAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
}
interface JsonView {
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

/** One primitive of a node in the model frame (translation applied, float64). */
interface Tris {
  positions: number[];
  normals: number[] | null;
  indices: number[];
  doubleSided: boolean;
}

const MIN_AREA = 1e-10;
const WELD = 1e4; // 0.1 mm
const PLANE_EPS = 1e-4;
const LOOP_CENTRE_TOL = 0.02;
const LOOP_RADIUS_TOL = 0.02;
const INTERIOR = 0.95;

class Bad extends Error {}

function readAccessor(
  json: Record<string, unknown>,
  bin: Uint8Array,
  index: number,
): { values: number[]; size: number } {
  const acc = (json.accessors as JsonAccessor[] | undefined)?.[index];
  if (!acc) throw new Bad(`accessor ${String(index)} is missing`);
  const view =
    acc.bufferView === undefined
      ? undefined
      : (json.bufferViews as JsonView[] | undefined)?.[acc.bufferView];
  if (!view) throw new Bad(`accessor ${String(index)} has no buffer view`);
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  if (size === undefined) throw new Bad(`accessor ${String(index)} type ${acc.type}`);
  const bytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
  if (bytes === undefined)
    throw new Bad(`accessor ${String(index)} component ${String(acc.componentType)}`);
  const stride = view.byteStride ?? size * bytes;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (acc.count > 0 && start + stride * (acc.count - 1) + size * bytes > bin.byteLength)
    throw new Bad(`accessor ${String(index)} runs past the binary chunk`);
  const values: number[] = [];
  for (let i = 0; i < acc.count; i++)
    for (let k = 0; k < size; k++) {
      const at = start + i * stride + k * bytes;
      values.push(
        acc.componentType === 5126
          ? dv.getFloat32(at, true)
          : acc.componentType === 5125
            ? dv.getUint32(at, true)
            : acc.componentType === 5123
              ? dv.getUint16(at, true)
              : dv.getUint8(at),
      );
    }
  return { values, size };
}

const at3 = (a: readonly number[], i: number): V3 => [
  a[3 * i] ?? 0,
  a[3 * i + 1] ?? 0,
  a[3 * i + 2] ?? 0,
];

/** Two-dimensional helpers in an opening's plane. */
type P2 = [number, number];
const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const cross2 = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
function segDist(p: P2, a: P2, b: P2): number {
  const ab = sub2(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t =
    l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * ab[0]), p[1] - (a[1] + t * ab[1]));
}
function inPolygon(p: P2, poly: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] ?? p;
    const b = poly[j] ?? p;
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function inTriangle(p: P2, t: readonly [P2, P2, P2]): boolean {
  const s = [0, 1, 2].map((i) => cross2(sub2(t[(i + 1) % 3] ?? p, t[i] ?? p), sub2(p, t[i] ?? p)));
  return s.every((v) => v >= 0) || s.every((v) => v <= 0);
}

/** The interior of one opening in its plane, and whether a point or segment in the plane reaches it. */
class OpeningRegion {
  readonly n: V3;
  private readonly u: V3;
  private readonly v: V3;
  private readonly poly: P2[] | null;
  private readonly tol: number;

  constructor(readonly o: Opening) {
    this.n = norm(o.normal);
    [this.u, this.v] = basis(this.n);
    this.poly = o.outline ? o.outline.map((q) => this.to2(q)) : null;
    this.tol = Math.max(1e-3, 0.02 * o.r);
  }

  to2(p: V3): P2 {
    const d = sub(p, this.o.centre);
    return [dot(d, this.u), dot(d, this.v)];
  }

  private pointIn(p: P2): boolean {
    const poly = this.poly;
    if (!poly) return Math.hypot(p[0], p[1]) < INTERIOR * this.o.r;
    if (!inPolygon(p, poly)) return false;
    return poly.every((a, i) => segDist(p, a, poly[(i + 1) % poly.length] ?? a) > this.tol);
  }

  segmentIn(a: P2, b: P2): boolean {
    const poly = this.poly;
    if (!poly) return segDist([0, 0], a, b) < INTERIOR * this.o.r;
    // inside-ness changes only where the segment crosses an edge: test the ends and the middles
    const ts = [0, 1];
    const d = sub2(b, a);
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length] ?? p;
      const e = sub2(q, p);
      const den = cross2(d, e);
      if (Math.abs(den) < 1e-15) return;
      const t = cross2(sub2(p, a), e) / den;
      const s = cross2(sub2(p, a), d) / den;
      if (t > 0 && t < 1 && s >= 0 && s <= 1) ts.push(t);
    });
    ts.sort((x, y) => x - y);
    const pts = ts.flatMap((t, i) => {
      const next = ts[i + 1];
      return next === undefined ? [t] : [t, (t + next) / 2];
    });
    return pts.some((t) => this.pointIn([a[0] + t * d[0], a[1] + t * d[1]]));
  }

  triangleIn(t: [P2, P2, P2]): boolean {
    const probe: P2 = this.poly
      ? [
          this.poly.reduce((s, p) => s + p[0], 0) / this.poly.length,
          this.poly.reduce((s, p) => s + p[1], 0) / this.poly.length,
        ]
      : [0, 0];
    if (inTriangle(probe, t)) return true;
    return [0, 1, 2].some((i) => this.segmentIn(t[i] ?? probe, t[(i + 1) % 3] ?? probe));
  }

  /** Whether triangle `a b c` (model frame) crosses or covers the opening's interior. */
  crossedBy(a: V3, b: V3, c: V3): boolean {
    const pts = [a, b, c];
    const d = pts.map((p) => dot(sub(p, this.o.centre), this.n));
    const s = d.map((x) => (x > PLANE_EPS ? 1 : x < -PLANE_EPS ? -1 : 0));
    if (s.every((x) => x === 0)) return this.triangleIn([this.to2(a), this.to2(b), this.to2(c)]);
    if (s.every((x) => x >= 0) && s.some((x) => x > 0) && !s.includes(0)) return false;
    if (s.every((x) => x <= 0) && !s.includes(0)) return false;
    const hits: V3[] = [];
    for (let i = 0; i < 3; i++) {
      const p = pts[i] ?? a;
      if (s[i] === 0) hits.push(p);
      const j = (i + 1) % 3;
      const si = s[i] ?? 0;
      const sj = s[j] ?? 0;
      if (si * sj < 0) {
        const q = pts[j] ?? a;
        const di = d[i] ?? 0;
        const t = di / (di - (d[j] ?? 0));
        hits.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
      }
    }
    const [h0, h1] = hits;
    if (!h0) return false;
    return this.segmentIn(this.to2(h0), this.to2(h1 ?? h0));
  }

  /**
   * Whether `inner` is a smaller circular opening in this one's plane, wholly inside it (a lined
   * bore): the passage is then the inner one, which alone has to stay clear.
   */
  encloses(inner: OpeningRegion): boolean {
    if (this.o.outline || inner.o.outline || dot(this.n, inner.n) < 0.999) return false;
    const d = sub(inner.o.centre, this.o.centre);
    if (Math.abs(dot(d, this.n)) > PLANE_EPS) return false;
    return len(d) + inner.o.r < this.o.r;
  }

  /** Whether a boundary loop (model frame points) is this opening's rim. */
  matchesLoop(loop: readonly V3[]): boolean {
    if (loop.length === 0) return false;
    const c: V3 = [0, 1, 2].map(
      (k) => loop.reduce((s, p) => s + p[k as 0 | 1 | 2], 0) / loop.length,
    ) as V3;
    if (this.o.outline) {
      const outline = this.o.outline;
      return loop.every((p) =>
        outline.some((a, i) => {
          const b = outline[(i + 1) % outline.length] ?? a;
          const ab = sub(b, a);
          const l2 = dot(ab, ab);
          const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
          return (
            len(sub(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]])) <= LOOP_CENTRE_TOL
          );
        }),
      );
    }
    if (len(sub(c, this.o.centre)) > LOOP_CENTRE_TOL) return false;
    const r = loop.reduce((s, p) => s + len(sub(p, c)), 0) / loop.length;
    return Math.abs(r - this.o.r) <= LOOP_RADIUS_TOL * this.o.r;
  }
}

/** Boundary loops (model frame points) of the welded triangles of `tris`. */
function boundaryLoops(tris: readonly Tris[]): V3[][] {
  const ids = new Map<string, number>();
  const pos: V3[] = [];
  const edges = new Map<string, number>();
  for (const t of tris) {
    const weld = t.positions.length / 3;
    const w: number[] = [];
    for (let i = 0; i < weld; i++) {
      const p = at3(t.positions, i);
      const key = p.map((x) => Math.round(x * WELD)).join(',');
      let id = ids.get(key);
      if (id === undefined) {
        id = pos.push(p) - 1;
        ids.set(key, id);
      }
      w.push(id);
    }
    for (let k = 0; k + 2 < t.indices.length; k += 3) {
      const v = [0, 1, 2].map((e) => w[t.indices[k + e] ?? 0] ?? 0);
      for (let e = 0; e < 3; e++) {
        const a = v[e] ?? 0;
        const b = v[(e + 1) % 3] ?? 0;
        if (a === b) continue;
        const key = a < b ? `${String(a)} ${String(b)}` : `${String(b)} ${String(a)}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
  }
  const adj = new Map<number, number[]>();
  for (const [key, n] of edges) {
    if (n !== 1) continue;
    const [a, b] = key.split(' ').map(Number);
    if (a === undefined || b === undefined) continue;
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  const loops: V3[][] = [];
  const take = (a: number, b: number) => {
    adj.set(
      a,
      (adj.get(a) ?? []).filter((x) => x !== b),
    );
    adj.set(
      b,
      (adj.get(b) ?? []).filter((x) => x !== a),
    );
  };
  for (const start of [...adj.keys()]) {
    while ((adj.get(start)?.length ?? 0) > 0) {
      const loop: V3[] = [];
      let at = start;
      for (let guard = 0; guard < 10_000_000; guard++) {
        const next = adj.get(at)?.[0];
        if (next === undefined) break;
        take(at, next);
        loop.push(pos[at] ?? [0, 0, 0]);
        at = next;
        if (at === start) break;
      }
      loops.push(loop);
    }
  }
  return loops;
}

const isOpening = (v: unknown): v is Opening => {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const v3 = (x: unknown) =>
    Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number');
  return (
    v3(o.centre) &&
    v3(o.normal) &&
    typeof o.r === 'number' &&
    (o.outline === undefined || (Array.isArray(o.outline) && o.outline.every(v3)))
  );
};

/** Checks a GLB file; see the module comment. */
export async function validateGlb(
  glb: Uint8Array,
  o: { budget: number; openings?: Record<string, Opening[]>; khronos: KhronosValidator },
): Promise<GlbReport> {
  const report: GlbReport = {
    validatorErrors: 0,
    validatorWarnings: 0,
    messages: [],
    finite: true,
    indicesValid: true,
    normalsUnit: true,
    degenerate: 0,
    duplicateTris: 0,
    unintendedHoles: [],
    intendedOpenOk: true,
    triangles: 0,
    withinBudget: true,
  };
  try {
    const k = await o.khronos(glb);
    report.validatorErrors = k.errors;
    report.validatorWarnings = k.warnings;
    report.messages.push(...k.messages);
  } catch (e) {
    report.validatorErrors += 1;
    report.messages.push(`error VALIDATOR_FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: Record<string, unknown>;
  let bin: Uint8Array;
  try {
    ({ json, bin } = readGlb(glb));
  } catch (e) {
    report.validatorErrors += 1;
    report.messages.push(`error GLB_UNREADABLE: ${e instanceof Error ? e.message : String(e)}`);
    report.finite = report.indicesValid = report.normalsUnit = report.intendedOpenOk = false;
    return report;
  }
  const nodes = (json.nodes ?? []) as JsonNode[];
  const meshes = (json.meshes ?? []) as { primitives: JsonPrimitive[] }[];
  const materials = (json.materials ?? []) as { doubleSided?: boolean }[];
  const scenes = (json.scenes ?? []) as { nodes?: number[] }[];
  const seen = new Set<number>();
  const visit = (i: number, offset: V3) => {
    const n = nodes[i];
    if (!n || seen.has(i)) return;
    seen.add(i);
    const t = n.translation ?? [0, 0, 0];
    const here: V3 = [offset[0] + (t[0] ?? 0), offset[1] + (t[1] ?? 0), offset[2] + (t[2] ?? 0)];
    if (n.mesh !== undefined) checkNode(n, here);
    for (const c of n.children ?? []) visit(c, here);
  };
  const checkNode = (n: JsonNode, offset: V3) => {
    const name = n.name ?? '';
    const tris: Tris[] = [];
    let nodeFinite = true;
    for (const p of meshes[n.mesh ?? -1]?.primitives ?? []) {
      if (p.mode !== undefined && p.mode !== 4) continue;
      const posIndex = p.attributes.POSITION;
      if (posIndex === undefined) continue;
      try {
        const pos = readAccessor(json, bin, posIndex).values;
        const count = pos.length / 3;
        const normals =
          p.attributes.NORMAL === undefined
            ? null
            : readAccessor(json, bin, p.attributes.NORMAL).values;
        const indices =
          p.indices === undefined
            ? Array.from({ length: count }, (_, i) => i)
            : readAccessor(json, bin, p.indices).values;
        if (!pos.every(Number.isFinite) || normals?.every(Number.isFinite) === false) {
          report.finite = false;
          nodeFinite = false;
        }
        if (indices.some((i) => i >= count)) report.indicesValid = false;
        if (normals?.length !== pos.length) report.normalsUnit = false;
        else
          for (let i = 0; i < normals.length; i += 3)
            if (
              Math.abs(Math.hypot(normals[i] ?? 0, normals[i + 1] ?? 0, normals[i + 2] ?? 0) - 1) >
              1e-3
            )
              report.normalsUnit = false;
        const world = pos.map((v, i) => v + offset[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2]);
        tris.push({
          positions: world,
          normals,
          indices: indices.map((i) => (i < count ? i : 0)),
          doubleSided: materials[p.material ?? -1]?.doubleSided === true,
        });
        report.triangles += Math.floor(indices.length / 3);
      } catch (e) {
        if (!(e instanceof Bad)) throw e;
        report.indicesValid = false;
        report.messages.push(`error NODE_UNREADABLE: ${name}: ${e.message}`);
      }
    }
    if (!nodeFinite) return; // the geometry checks need finite positions
    // zero-area and duplicate triangles (duplicates over welded positions, any primitive)
    const keys = new Set<string>();
    for (const t of tris)
      for (let k = 0; k + 2 < t.indices.length; k += 3) {
        const [a, b, c] = [0, 1, 2].map((e) => at3(t.positions, t.indices[k + e] ?? 0)) as [
          V3,
          V3,
          V3,
        ];
        if (len(cross(sub(b, a), sub(c, a))) / 2 < MIN_AREA) {
          report.degenerate++;
          continue;
        }
        const key = [a, b, c]
          .map((p) => p.map((x) => Math.round(x * WELD)).join(','))
          .sort()
          .join('|');
        if (keys.has(key)) report.duplicateTris++;
        else keys.add(key);
      }
    // declared openings: from the caller, else from the node extras
    const given = o.openings?.[name];
    const fromExtras = n.extras?.openings;
    const openings = (given ?? (Array.isArray(fromExtras) ? fromExtras : [])).filter(isOpening);
    const regions = openings.map((x) => new OpeningRegion(x));
    const open = regions.filter((r) => !regions.some((inner) => inner !== r && r.encloses(inner)));
    for (const r of open)
      for (const t of tris)
        for (let k = 0; k + 2 < t.indices.length && report.intendedOpenOk; k += 3) {
          const [a, b, c] = [0, 1, 2].map((e) => at3(t.positions, t.indices[k + e] ?? 0)) as [
            V3,
            V3,
            V3,
          ];
          if (r.crossedBy(a, b, c)) report.intendedOpenOk = false;
        }
    const loops = boundaryLoops(tris.filter((t) => !t.doubleSided)).filter(
      (loop) => !regions.some((r) => r.matchesLoop(loop)),
    );
    if (loops.length) report.unintendedHoles.push({ node: name, loops: loops.length });
  };
  const roots = scenes[0]?.nodes ?? nodes.map((_, i) => i);
  for (const r of roots) visit(r, [0, 0, 0]);
  report.withinBudget = report.triangles <= o.budget;
  return report;
}
