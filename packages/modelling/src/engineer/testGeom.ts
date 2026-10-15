/**
 * Mesh checks shared by the geometry kernel and the engineering builder tests. Every check welds
 * vertices by position (0.1 mm) first, so separate vertices at one point (hard edges, seams
 * between primitives of one material) count as one.
 */
import type { Prim, V3 } from './geom';

/** The value, or a thrown error when it is missing: the test-side stand-in for `x!`. */
export function must<T>(v: T | undefined | null, what = 'value'): T {
  if (v === undefined || v === null) throw new Error(`expected ${what} to be present`);
  return v;
}

/** Position of vertex `i`. */
export function vertexAt(p: Prim, i: number): V3 {
  return [p.positions[3 * i] ?? 0, p.positions[3 * i + 1] ?? 0, p.positions[3 * i + 2] ?? 0];
}

/** Welded vertex id of every vertex, and one representative vertex index per welded id. */
function weld(p: Prim): { id: number[]; rep: number[] } {
  const key = (v: V3) => v.map((x) => Math.round(x * 1e4)).join(',');
  const ids = new Map<string, number>();
  const id: number[] = [];
  const rep: number[] = [];
  for (let i = 0; i < p.positions.length / 3; i++) {
    const k = key(vertexAt(p, i));
    let w = ids.get(k);
    if (w === undefined) {
      w = ids.size;
      ids.set(k, w);
      rep.push(i);
    }
    id.push(w);
  }
  return { id, rep };
}

/** Directed edge use counts over welded vertices, collapsed edges left out. */
function directedEdges(p: Prim, id: number[]): Map<string, number> {
  const directed = new Map<string, number>();
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => id[p.indices[t + k] ?? 0] ?? 0);
    for (let e = 0; e < 3; e++) {
      const a = v[e] ?? 0;
      const b = v[(e + 1) % 3] ?? 0;
      if (a === b) continue;
      const k = `${String(a)}>${String(b)}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  return directed;
}

/**
 * Boundary loops: welded edges used by one triangle only, chained into loops. Each loop is a list
 * of vertex indices (one representative per welded position), in the order the triangles wind them.
 */
export function boundaryLoops(p: Prim): number[][] {
  const { id, rep } = weld(p);
  const directed = directedEdges(p, id);
  const next = new Map<number, number[]>();
  for (const [k, n] of directed) {
    const [a, b] = k.split('>');
    if (directed.has(`${b ?? ''}>${a ?? ''}`) || n !== 1) continue;
    const from = Number(a);
    next.set(from, [...(next.get(from) ?? []), Number(b)]);
  }
  const loops: number[][] = [];
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop: number[] = [];
      let at = start;
      for (let guard = 0; guard < 1_000_000; guard++) {
        const outs = next.get(at) ?? [];
        const to = outs.shift();
        if (to === undefined) break;
        loop.push(rep[at] ?? 0);
        at = to;
        if (at === start) break;
      }
      loops.push(loop);
    }
  }
  return loops;
}

/** Centroid and mean distance from it of a boundary loop. */
export function loopCentreRadius(p: Prim, loop: number[]): { centre: V3; r: number } {
  const pts = loop.map((i) => vertexAt(p, i));
  const c: V3 = [0, 1, 2].map(
    (k) => pts.reduce((s, q) => s + q[k as 0 | 1 | 2], 0) / pts.length,
  ) as V3;
  const r =
    pts.reduce((s, q) => s + Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]), 0) / pts.length;
  return { centre: c, r };
}

/** Signed volume by the divergence theorem (positive when the faces point outwards). */
export function volume(p: Prim): number {
  let v = 0;
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    const a = vertexAt(p, p.indices[t] ?? 0);
    const b = vertexAt(p, p.indices[t + 1] ?? 0);
    const c = vertexAt(p, p.indices[t + 2] ?? 0);
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}

/** Every welded edge is used once in each direction (closed, consistently wound) and the volume is positive. */
export function closedAndWound(p: Prim): boolean {
  const directed = directedEdges(p, weld(p).id);
  if (directed.size === 0) return false;
  for (const [k, n] of directed) {
    const [a, b] = k.split('>');
    if (n !== 1 || directed.get(`${b ?? ''}>${a ?? ''}`) !== 1) return false;
  }
  return volume(p) > 0;
}

function faceNormal(p: Prim, t: number): V3 {
  const a = vertexAt(p, p.indices[t] ?? 0);
  const b = vertexAt(p, p.indices[t + 1] ?? 0);
  const c = vertexAt(p, p.indices[t + 2] ?? 0);
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [
    (u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0),
    (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0),
    (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0),
  ];
}

/** Each triangle's winding agrees with the sum of its vertex normals. */
export function normalsAgree(p: Prim): boolean {
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    const n = faceNormal(p, t);
    if (Math.hypot(...n) < 1e-12) continue;
    const vn = [0, 1, 2].map((k) =>
      [0, 1, 2].reduce((s, j) => s + (p.normals[3 * (p.indices[t + j] ?? 0) + k] ?? 0), 0),
    );
    if (n[0] * (vn[0] ?? 0) + n[1] * (vn[1] ?? 0) + n[2] * (vn[2] ?? 0) <= 0) return false;
  }
  return true;
}

/** Every normal has length 1 within 1e-4. */
export function normalsUnit(p: Prim): boolean {
  if (p.normals.length !== p.positions.length) return false;
  for (let i = 0; i < p.normals.length; i += 3) {
    const l = Math.hypot(p.normals[i] ?? 0, p.normals[i + 1] ?? 0, p.normals[i + 2] ?? 0);
    if (Math.abs(l - 1) > 1e-4) return false;
  }
  return true;
}

/** Triangles with (almost) no area. */
export function degenerateTriangles(p: Prim, minArea = 1e-10): number {
  let n = 0;
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    if (Math.hypot(...faceNormal(p, t)) / 2 < minArea) n++;
  }
  return n;
}

/** Total triangle area. */
export function surfaceArea(p: Prim): number {
  let s = 0;
  for (let t = 0; t + 2 < p.indices.length; t += 3) s += Math.hypot(...faceNormal(p, t)) / 2;
  return s;
}

/** Axis-aligned bounds of the positions. */
export function bounds(p: Prim): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.positions.length / 3; i++) {
    const v = vertexAt(p, i);
    for (const k of [0, 1, 2] as const) {
      min[k] = Math.min(min[k], v[k]);
      max[k] = Math.max(max[k], v[k]);
    }
  }
  return { min, max };
}

/** All the usual checks for a closed solid at once, for compact builder tests. */
export function solidOk(p: Prim): boolean {
  return closedAndWound(p) && normalsAgree(p) && normalsUnit(p) && degenerateTriangles(p) === 0;
}

/** V - E + F of the welded mesh: 2 for a sphere-like solid, 2 - 2g with g through-holes. */
export function eulerCharacteristic(p: Prim): number {
  const ids = new Map<string, number>();
  const id = (i: number) => {
    const k = vertexAt(p, i)
      .map((v) => Math.round(v * 1e4))
      .join(',');
    let w = ids.get(k);
    if (w === undefined) {
      w = ids.size;
      ids.set(k, w);
    }
    return w;
  };
  const edges = new Set<string>();
  for (let t = 0; t + 2 < p.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => id(p.indices[t + k] ?? 0));
    for (let e = 0; e < 3; e++) {
      const a = v[e] ?? 0;
      const b = v[(e + 1) % 3] ?? 0;
      edges.add(a < b ? `${String(a)}-${String(b)}` : `${String(b)}-${String(a)}`);
    }
  }
  return ids.size - edges.size + p.indices.length / 3;
}
