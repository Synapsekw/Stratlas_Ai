import type { ProcModel, ProcPart, Vec2 } from '@aio/schema';
import { writeGlb, type GlbPart } from './glb';
import { partAnchor, ringArea } from './procmodel';

/** A built model: the GLB bytes and the node name of each meshed part, in order. */
export interface MeshedModel {
  glb: Uint8Array;
  nodes: string[];
  /** The part id of each node, in the same order. */
  partIds: string[];
}

/** One part as triangles: positions relative to `translation` (the part's anchor). */
export interface PartMesh {
  translation: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * The GLB node name of a part: its plant tag, else its name, else its id. Issues, tags and part
 * matching across dates (`@aio/workspace` captures) use this name.
 */
export function partNodeName(part: ProcPart): string {
  const named = [part.tag, part.name].map((v) => v?.trim() ?? '').find((v) => v !== '');
  return named ?? part.id;
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};

/** Collects vertices (absolute, float64) and triangles wound to agree with their normals. */
class Builder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly idx: number[] = [];

  vertex(p: V3, n: V3): number {
    const u = norm(n);
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(u[0], u[1], u[2]);
    return this.pos.length / 3 - 1;
  }

  private at(i: number): V3 {
    return [this.pos[3 * i] ?? 0, this.pos[3 * i + 1] ?? 0, this.pos[3 * i + 2] ?? 0];
  }

  private normal(i: number): V3 {
    return [this.nrm[3 * i] ?? 0, this.nrm[3 * i + 1] ?? 0, this.nrm[3 * i + 2] ?? 0];
  }

  /** A triangle; flipped when its winding disagrees with the vertex normals. */
  tri(a: number, b: number, c: number): void {
    const pa = this.at(a);
    const face = cross(sub(this.at(b), pa), sub(this.at(c), pa));
    const n = add(add(this.normal(a), this.normal(b)), this.normal(c));
    if (dot(face, n) < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** A flat polygon (convex, or triangulated by the caller) with one normal. */
  fan(points: readonly V3[], n: V3): void {
    const ids = points.map((p) => this.vertex(p, n));
    for (let i = 1; i + 1 < ids.length; i++) this.tri(ids[0] ?? 0, ids[i] ?? 0, ids[i + 1] ?? 0);
  }

  build(anchor: V3): PartMesh {
    const positions = new Float32Array(this.pos.length);
    for (let i = 0; i < this.pos.length; i++) {
      positions[i] = (this.pos[i] ?? 0) - (anchor[i % 3] ?? 0);
    }
    return {
      translation: anchor,
      positions,
      normals: Float32Array.from(this.nrm),
      indices: Uint32Array.from(this.idx),
    };
  }
}

/** Segments around a circle: about 0.4 m chords, 24 to 96. */
const segmentsFor = (r: number) => Math.max(24, Math.min(96, Math.ceil((2 * Math.PI * r) / 0.4)));

function ring(c: V3, r: number, n: number): V3[] {
  return Array.from({ length: n }, (_, i): V3 => {
    const a = (2 * Math.PI * i) / n;
    return [c[0] + r * Math.cos(a), c[1], c[2] + r * Math.sin(a)];
  });
}

function cylinder(b: Builder, p: Extract<ProcPart, { kind: 'cylinder' }>): void {
  const n = segmentsFor(p.radius);
  const [x, y0, z] = p.base;
  const y1 = y0 + p.height;
  const bottom = ring([x, y0, z], p.radius, n);
  const top = ring([x, y1, z], p.radius, n);
  // side, smooth
  const side = (q: V3): V3 => [q[0] - x, 0, q[2] - z];
  const sb = bottom.map((q) => b.vertex(q, side(q)));
  const st = top.map((q) => b.vertex(q, side(q)));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.quad(sb[i] ?? 0, sb[j] ?? 0, st[j] ?? 0, st[i] ?? 0);
  }
  // bottom
  b.fan([...bottom].reverse(), [0, -1, 0]);
  const roof = p.roof ?? 'flat';
  const rh =
    p.roofHeight ?? (roof === 'cone' ? 0.15 * p.radius : roof === 'dome' ? 0.2 * p.radius : 0);
  if (roof === 'flat' || rh <= 0) {
    b.fan(top, [0, 1, 0]);
    return;
  }
  if (roof === 'cone') {
    const apex: V3 = [x, y1 + rh, z];
    const slope = rh / p.radius;
    const coneN = (q: V3): V3 => {
      const d = norm([q[0] - x, 0, q[2] - z]);
      return [d[0], 1 / slope, d[2]];
    };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const qi = top[i] ?? apex;
      const qj = top[j] ?? apex;
      const mid = norm(add(coneN(qi), coneN(qj)));
      b.tri(b.vertex(qi, coneN(qi)), b.vertex(qj, coneN(qj)), b.vertex(apex, mid));
    }
    return;
  }
  // dome: a spherical cap through the rim, rh above it
  const R = (p.radius * p.radius + rh * rh) / (2 * rh);
  const centre: V3 = [x, y1 + rh - R, z];
  const phiMax = Math.asin(Math.min(1, p.radius / R));
  const rings = Math.max(4, Math.ceil(phiMax / (Math.PI / 24)));
  const rows: number[][] = [];
  for (let k = 0; k < rings; k++) {
    const phi = phiMax * (1 - k / rings);
    const rr = R * Math.sin(phi);
    const yy = centre[1] + R * Math.cos(phi);
    const pts = k === 0 ? top : ring([x, yy, z], rr, n);
    rows.push(pts.map((q) => b.vertex(q, sub(q, centre))));
  }
  const apex = b.vertex([x, centre[1] + R, z], [0, 1, 0]);
  for (let k = 0; k + 1 < rows.length; k++) {
    const r0 = rows[k] ?? [];
    const r1 = rows[k + 1] ?? [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      b.quad(r0[i] ?? 0, r0[j] ?? 0, r1[j] ?? 0, r1[i] ?? 0);
    }
  }
  const last = rows.at(-1) ?? [];
  for (let i = 0; i < n; i++) b.tri(last[i] ?? 0, last[(i + 1) % n] ?? 0, apex);
}

function box(b: Builder, p: Extract<ProcPart, { kind: 'box' }>): void {
  const yaw = ((p.yawDeg ?? 0) * Math.PI) / 180;
  // rotation about +Y (three.js): counter-clockwise seen from above
  const ex: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const ez: V3 = [Math.sin(yaw), 0, Math.cos(yaw)];
  const ey: V3 = [0, 1, 0];
  const [sx, sy, sz] = p.size;
  const corner = (i: number, j: number, k: number): V3 =>
    add(add(add(p.base, scale(ex, (i - 0.5) * sx)), scale(ey, j * sy)), scale(ez, (k - 0.5) * sz));
  const faces: { n: V3; c: [number, number, number][] }[] = [
    {
      n: ex,
      c: [
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
        [1, 0, 1],
      ],
    },
    {
      n: scale(ex, -1),
      c: [
        [0, 0, 0],
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
      ],
    },
    {
      n: ey,
      c: [
        [0, 1, 0],
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0],
      ],
    },
    {
      n: scale(ey, -1),
      c: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
    },
    {
      n: ez,
      c: [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ],
    },
    {
      n: scale(ez, -1),
      c: [
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [1, 0, 0],
      ],
    },
  ];
  for (const f of faces)
    b.fan(
      f.c.map(([i, j, k]) => corner(i, j, k)),
      f.n,
    );
}

/** Ear clipping of a simple polygon; triangles index into `ring`. */
export function triangulate(ring: readonly Vec2[]): [number, number, number][] {
  const pts = [...ring];
  // work counter-clockwise in (x, z)
  const idx = pts.map((_, i) => i);
  if (ringArea(pts) < 0) idx.reverse();
  const out: [number, number, number][] = [];
  const P = (i: number): Vec2 => pts[i] ?? [0, 0];
  const crossZ = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) =>
    crossZ(a, b, p) >= -1e-12 && crossZ(b, c, p) >= -1e-12 && crossZ(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length] ?? 0;
      const i1 = idx[k] ?? 0;
      const i2 = idx[(k + 1) % idx.length] ?? 0;
      const [a, b, c] = [P(i0), P(i1), P(i2)];
      if (crossZ(a, b, c) <= 1e-12) continue;
      const blocked = idx.some((j) => j !== i0 && j !== i1 && j !== i2 && inside(P(j), a, b, c));
      if (blocked) continue;
      out.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate: fan the rest
  }
  for (let k = 1; k + 1 < idx.length; k++) out.push([idx[0] ?? 0, idx[k] ?? 0, idx[k + 1] ?? 0]);
  return out;
}

function extrusion(b: Builder, p: Extract<ProcPart, { kind: 'extrusion' }>): void {
  const fp = p.footprint;
  const y0 = p.baseY;
  const y1 = p.baseY + p.height;
  const tris = triangulate(fp);
  const at = (q: Vec2, y: number): V3 => [q[0], y, q[1]];
  const top = fp.map((q) => b.vertex(at(q, y1), [0, 1, 0]));
  const bottom = fp.map((q) => b.vertex(at(q, y0), [0, -1, 0]));
  for (const [i, j, k] of tris) {
    b.tri(top[i] ?? 0, top[j] ?? 0, top[k] ?? 0);
    b.tri(bottom[i] ?? 0, bottom[k] ?? 0, bottom[j] ?? 0);
  }
  // walls, outward: for a counter-clockwise ring in (x, z) the outside is to the right... use area
  const ccw = ringArea(fp) > 0;
  for (let i = 0; i < fp.length; i++) {
    const a = fp[i] ?? [0, 0];
    const c = fp[(i + 1) % fp.length] ?? [0, 0];
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    if (Math.hypot(dx, dz) < 1e-9) continue;
    // in (x, z) with positive area the interior is on the left of a->c; outward is the right
    const n: V3 = ccw ? [dz, 0, -dx] : [-dz, 0, dx];
    b.fan([at(a, y0), at(c, y0), at(c, y1), at(a, y1)], n);
  }
}

/** A perpendicular unit vector to d. */
function perpendicular(d: V3): V3 {
  const helper: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return norm(cross(d, helper));
}

function pipe(b: Builder, p: Extract<ProcPart, { kind: 'pipe' }>): void {
  const pts: V3[] = [];
  for (const q of p.points) {
    const v: V3 = [q[0], q[1], q[2]];
    const last = pts.at(-1);
    if (!last || Math.hypot(...sub(v, last)) > 1e-6) pts.push(v);
  }
  if (pts.length < 2) return;
  const r = p.diameter / 2;
  const n = 16;
  const dirs = pts.slice(1).map((q, i) => norm(sub(q, pts[i] ?? q)));
  const d0 = dirs[0] ?? [1, 0, 0];
  const u = perpendicular(d0);
  const v = cross(d0, u);
  const start = pts[0] ?? [0, 0, 0];
  let rows: V3[] = Array.from({ length: n }, (_, k) => {
    const a = (2 * Math.PI * k) / n;
    return add(start, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
  });
  const rings: V3[][] = [rows];
  for (let i = 1; i < pts.length; i++) {
    const dPrev = dirs[i - 1] ?? d0;
    const dNext = dirs[i] ?? dPrev;
    let m = add(dPrev, dNext);
    if (Math.hypot(...m) < 1e-6) m = dPrev;
    m = norm(m);
    const at = pts[i] ?? start;
    rows = rows.map((q) => {
      const t = dot(sub(at, q), m) / dot(dPrev, m);
      return add(q, scale(dPrev, t));
    });
    rings.push(rows);
  }
  // sides of each segment, normals perpendicular to the segment
  for (let s = 0; s + 1 < rings.length; s++) {
    const d = dirs[s] ?? d0;
    const a = pts[s] ?? start;
    const radial = (q: V3): V3 => {
      const w = sub(q, a);
      return sub(w, scale(d, dot(w, d)));
    };
    const r0 = (rings[s] ?? []).map((q) => b.vertex(q, radial(q)));
    const r1 = (rings[s + 1] ?? []).map((q) => b.vertex(q, radial(q)));
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      b.quad(r0[k] ?? 0, r0[j] ?? 0, r1[j] ?? 0, r1[k] ?? 0);
    }
  }
  b.fan(rings[0] ?? [], scale(d0, -1));
  b.fan(rings.at(-1) ?? [], dirs.at(-1) ?? d0);
}

function sphere(b: Builder, p: Extract<ProcPart, { kind: 'sphere' }>): void {
  const n = segmentsFor(p.radius);
  const rows = Math.max(8, Math.round(n / 2));
  const c = p.center;
  const ids: number[][] = [];
  for (let k = 1; k < rows; k++) {
    const phi = (Math.PI * k) / rows;
    const pts = ring([c[0], c[1] + p.radius * Math.cos(phi), c[2]], p.radius * Math.sin(phi), n);
    ids.push(pts.map((q) => b.vertex(q, sub(q, c))));
  }
  const top = b.vertex([c[0], c[1] + p.radius, c[2]], [0, 1, 0]);
  const bottom = b.vertex([c[0], c[1] - p.radius, c[2]], [0, -1, 0]);
  const first = ids[0] ?? [];
  const last = ids.at(-1) ?? [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    b.tri(first[i] ?? 0, first[j] ?? 0, top);
    b.tri(last[i] ?? 0, bottom, last[j] ?? 0);
  }
  for (let k = 0; k + 1 < ids.length; k++) {
    const r0 = ids[k] ?? [];
    const r1 = ids[k + 1] ?? [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      b.quad(r0[i] ?? 0, r0[j] ?? 0, r1[j] ?? 0, r1[i] ?? 0);
    }
  }
}

/** Triangles of one part: closed, wound outwards, relative to the part's anchor. */
export function meshPart(part: ProcPart): PartMesh {
  const b = new Builder();
  switch (part.kind) {
    case 'cylinder':
      cylinder(b, part);
      break;
    case 'box':
      box(b, part);
      break;
    case 'extrusion':
      extrusion(b, part);
      break;
    case 'pipe':
      pipe(b, part);
      break;
    case 'sphere':
      sphere(b, part);
      break;
  }
  return b.build(partAnchor(part));
}

/** sRGB colours by class, as linear RGB for COLOR_0. */
const CLASS_COLOURS: Record<string, string> = {
  tank: '#c9ccd1',
  vessel: '#b9c2cc',
  building: '#c8b79a',
  skid: '#d9a441',
  rack: '#a8a8a8',
  pipe: '#5b8fc9',
};
const DEFAULT_COLOUR = '#bfbfbf';
const DRAFT_COLOUR = '#f0a030';

function linearRgb(hex: string): V3 {
  const c = (i: number) => {
    const v = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [c(0), c(1), c(2)];
}

/**
 * A node name as three.js keeps it after loading (`PropertyBinding.sanitizeNodeName`: spaces
 * become `_`, `[ ] . : /` go), so the name in the file, in layer tags and in the selection agree.
 */
export function glbNodeName(name: string): string {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

/**
 * Mesh the parts of a model into a GLB, one node per part: `accepted` parts (the default), or
 * `all` but the rejected ones for the draft preview, where drafts are drawn in amber. Node names
 * come from `partNodeName` made safe by `glbNodeName`; a name two parts share gets the part id
 * added to the second.
 */
export function meshProcModel(
  model: ProcModel,
  opts: { parts?: 'accepted' | 'all' } = {},
): MeshedModel {
  const which = opts.parts ?? 'accepted';
  const parts = model.parts.filter((p) =>
    which === 'accepted' ? p.status === 'accepted' : p.status !== 'rejected',
  );
  const used = new Set<string>();
  const glbParts: GlbPart[] = [];
  const nodes: string[] = [];
  const partIds: string[] = [];
  for (const p of parts) {
    let name = glbNodeName(partNodeName(p));
    if (used.has(name)) name = glbNodeName(`${name}_${p.id}`);
    used.add(name);
    const m = meshPart(p);
    const rgb = linearRgb(
      p.status === 'draft' ? DRAFT_COLOUR : (CLASS_COLOURS[p.class ?? ''] ?? DEFAULT_COLOUR),
    );
    const colors = new Float32Array(m.positions.length);
    for (let i = 0; i < colors.length; i += 3) colors.set(rgb, i);
    const extras: Record<string, string> = { part: p.id };
    if (p.tag) extras.tag = p.tag;
    if (p.class) extras.type = p.class;
    glbParts.push({ name, extras: { tag: p.tag ?? name, ...extras }, ...m, colors });
    nodes.push(name);
    partIds.push(p.id);
  }
  const glb = writeGlb(glbParts, { root: model.id, generator: 'Quadrion AI model builder' });
  return { glb, nodes, partIds };
}
