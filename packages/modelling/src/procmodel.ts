import {
  PROCMODEL_SCHEMA,
  ProcModel,
  type PartStatus,
  type ProcModelSummary,
  type ProcPart,
  type Vec2,
} from '@aio/schema';

/**
 * Helpers for procedural models (`aio.procmodel/1`) beyond the zod schema: building, editing and
 * checking a model the way the Model builder and the agent tools do. Every function returns a new
 * model; nothing is changed in place.
 */

/** Parts further than this from the project origin are almost certainly misplaced. */
export const FAR_FROM_ORIGIN_M = 100_000;

export function newProcModel(o: {
  id: string;
  name: string;
  now: string;
  capture?: string;
}): ProcModel {
  return {
    schema: PROCMODEL_SCHEMA,
    id: o.id,
    name: o.name,
    createdAt: o.now,
    updatedAt: o.now,
    ...(o.capture ? { capture: o.capture } : {}),
    parts: [],
  };
}

export function summarise(m: ProcModel): Omit<ProcModelSummary, 'layer'> {
  return {
    id: m.id,
    name: m.name,
    parts: m.parts.length,
    accepted: m.parts.filter((p) => p.status === 'accepted').length,
    updatedAt: m.updatedAt,
  };
}

export function setPartStatus(
  m: ProcModel,
  ids: readonly string[] | 'all',
  status: PartStatus,
  now: string,
): ProcModel {
  const want = ids === 'all' ? null : new Set(ids);
  return {
    ...m,
    updatedAt: now,
    parts: m.parts.map((p) => (want === null || want.has(p.id) ? { ...p, status } : p)),
  };
}

function sameOrigin(a: ProcPart, b: ProcPart): boolean {
  return JSON.stringify(a.origin) === JSON.stringify(b.origin);
}

/**
 * Add parts as drafts. A part whose id and origin the model already has is the same part and is
 * skipped (adding a drawing twice does not double it); another part with a taken id gets a new id.
 */
export function addParts(m: ProcModel, parts: readonly ProcPart[], now: string): ProcModel {
  const out = [...m.parts];
  const taken = new Set(out.map((p) => p.id));
  for (const p of parts) {
    const same = out.find((q) => q.id === p.id);
    if (same && sameOrigin(same, p)) continue;
    let id = p.id;
    for (let n = 2; taken.has(id); n++) id = `${p.id}-${String(n)}`;
    taken.add(id);
    out.push({ ...p, id, status: 'draft' });
  }
  return { ...m, updatedAt: now, parts: out };
}

/** Fields a part edit may set: anything but its kind and id. */
export type PartPatch = Partial<Omit<ProcPart, 'kind' | 'id'>> & Record<string, unknown>;

export function updatePart(m: ProcModel, id: string, patch: PartPatch, now: string): ProcModel {
  const i = m.parts.findIndex((p) => p.id === id);
  const part = m.parts[i];
  if (!part) throw new Error(`The model has no part "${id}".`);
  const rest: Record<string, unknown> = { ...patch };
  delete rest.kind;
  delete rest.id;
  const next: ProcPart = { ...part, ...rest };
  const parts = [...m.parts];
  parts[i] = next;
  return { ...m, updatedAt: now, parts };
}

/** A part found by id, tag or name (case-insensitive for tags and names). */
export function findPart(m: ProcModel, key: string): ProcPart | undefined {
  const k = key.trim().toLowerCase();
  return (
    m.parts.find((p) => p.id === key) ??
    m.parts.find((p) => p.tag?.toLowerCase() === k) ??
    m.parts.find((p) => p.name?.toLowerCase() === k)
  );
}

// Dimensions ----------------------------------------------------------------------------------

export type DimensionKey =
  'x' | 'y' | 'z' | 'radius' | 'height' | 'roofHeight' | 'length' | 'width' | 'yawDeg' | 'diameter';

export interface Dimension {
  key: DimensionKey;
  label: string;
  value: number;
  unit: 'm' | '°';
}

const LABELS: Record<DimensionKey, string> = {
  x: 'East (x)',
  y: 'Base height (y)',
  z: 'South (z)',
  radius: 'Radius',
  height: 'Height',
  roofHeight: 'Roof height',
  length: 'Length',
  width: 'Width',
  yawDeg: 'Turn',
  diameter: 'Diameter',
};

const dim = (key: DimensionKey, value: number): Dimension => ({
  key,
  label: LABELS[key],
  value,
  unit: key === 'yawDeg' ? '°' : 'm',
});

function footprintCentre(fp: readonly Vec2[]): Vec2 {
  const n = fp.length || 1;
  return [fp.reduce((s, p) => s + p[0], 0) / n, fp.reduce((s, p) => s + p[1], 0) / n];
}

/** A reference point of the part: base centre, footprint centre or first pipe point. */
export function partAnchor(p: ProcPart): [number, number, number] {
  switch (p.kind) {
    case 'cylinder':
    case 'box':
      return [...p.base];
    case 'sphere':
      return [...p.center];
    case 'pipe': {
      const first = p.points[0] ?? [0, 0, 0];
      return [first[0], first[1], first[2]];
    }
    case 'extrusion': {
      const c = footprintCentre(p.footprint);
      return [c[0], p.baseY, c[1]];
    }
  }
}

/** The numbers a person can type for a part, in the order the editor shows them. */
export function partDimensions(p: ProcPart): Dimension[] {
  const [x, y, z] = partAnchor(p);
  const at = [dim('x', x), dim('y', y), dim('z', z)];
  switch (p.kind) {
    case 'cylinder':
      return [
        ...at,
        dim('radius', p.radius),
        dim('height', p.height),
        dim('roofHeight', p.roofHeight ?? 0),
      ];
    case 'box':
      return [
        ...at,
        dim('length', p.size[0]),
        dim('height', p.size[1]),
        dim('width', p.size[2]),
        dim('yawDeg', p.yawDeg ?? 0),
      ];
    case 'extrusion':
      return [...at, dim('height', p.height)];
    case 'pipe':
      return [...at, dim('diameter', p.diameter)];
    case 'sphere':
      return [...at, dim('radius', p.radius)];
  }
}

const POSITIVE: ReadonlySet<DimensionKey> = new Set([
  'radius',
  'height',
  'length',
  'width',
  'diameter',
]);

/** Set one dimension; moving x, y or z moves the whole part. */
export function applyDimension(p: ProcPart, key: DimensionKey, value: number): ProcPart {
  if (!Number.isFinite(value)) throw new Error(`${LABELS[key]} must be a number.`);
  if (POSITIVE.has(key) && value <= 0) throw new Error(`${LABELS[key]} must be more than 0.`);
  if (key === 'roofHeight' && value < 0) throw new Error('Roof height cannot be below 0.');
  if (key === 'x' || key === 'y' || key === 'z') {
    const a = partAnchor(p);
    const axis = key === 'x' ? 0 : key === 'y' ? 1 : 2;
    const d: [number, number, number] = [0, 0, 0];
    d[axis] = value - a[axis];
    return movePart(p, d);
  }
  switch (p.kind) {
    case 'cylinder':
      if (key === 'radius') return { ...p, radius: value };
      if (key === 'height') return { ...p, height: value };
      if (key === 'roofHeight') return { ...p, roofHeight: value };
      break;
    case 'box':
      if (key === 'length') return { ...p, size: [value, p.size[1], p.size[2]] };
      if (key === 'height') return { ...p, size: [p.size[0], value, p.size[2]] };
      if (key === 'width') return { ...p, size: [p.size[0], p.size[1], value] };
      if (key === 'yawDeg') return { ...p, yawDeg: ((((value + 180) % 360) + 360) % 360) - 180 };
      break;
    case 'extrusion':
      if (key === 'height') return { ...p, height: value };
      break;
    case 'pipe':
      if (key === 'diameter') return { ...p, diameter: value };
      break;
    case 'sphere':
      if (key === 'radius') return { ...p, radius: value };
      break;
  }
  throw new Error(`A ${p.kind} has no ${LABELS[key].toLowerCase()}.`);
}

/** Move a part by an offset in the local frame (metres). */
export function movePart(p: ProcPart, d: readonly [number, number, number]): ProcPart {
  const add = (v: readonly [number, number, number]): [number, number, number] => [
    v[0] + d[0],
    v[1] + d[1],
    v[2] + d[2],
  ];
  switch (p.kind) {
    case 'cylinder':
    case 'box':
      return { ...p, base: add(p.base) };
    case 'sphere':
      return { ...p, center: add(p.center) };
    case 'pipe':
      return { ...p, points: p.points.map(add) };
    case 'extrusion':
      return {
        ...p,
        baseY: p.baseY + d[1],
        footprint: p.footprint.map((q): Vec2 => [q[0] + d[0], q[1] + d[2]]),
      };
  }
}

const m1 = (v: number) => `${v.toFixed(1)} m`;

/** "Cylinder, radius 10.0 m, height 12.5 m". */
export function partSummary(p: ProcPart): string {
  switch (p.kind) {
    case 'cylinder':
      return `Cylinder, radius ${m1(p.radius)}, height ${m1(p.height)}`;
    case 'box':
      return `Box, ${p.size[0].toFixed(1)} by ${p.size[2].toFixed(1)} m, height ${m1(p.size[1])}`;
    case 'extrusion':
      return `Extrusion, ${String(p.footprint.length)} corners, height ${m1(p.height)}`;
    case 'pipe':
      return `Pipe, diameter ${(p.diameter * 1000).toFixed(0)} mm, ${m1(pipeLength(p.points))} long`;
    case 'sphere':
      return `Sphere, radius ${m1(p.radius)}`;
  }
}

export function pipeLength(points: readonly (readonly number[])[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] ?? [];
    const b = points[i] ?? [];
    len += Math.hypot(
      (b[0] ?? 0) - (a[0] ?? 0),
      (b[1] ?? 0) - (a[1] ?? 0),
      (b[2] ?? 0) - (a[2] ?? 0),
    );
  }
  return len;
}

// Checks --------------------------------------------------------------------------------------

export interface ModelProblem {
  message: string;
  /** The part the problem is about, when it is about one. */
  partId?: string;
}

/** Signed area of a ring in the [x, z] plane. */
export function ringArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] ?? [0, 0];
    const q = ring[(i + 1) % ring.length] ?? [0, 0];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function selfCrossing(ring: readonly Vec2[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const c = ring[j];
      const d = ring[(j + 1) % n];
      if (a && b && c && d && segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

function partProblems(p: ProcPart): string[] {
  const out: string[] = [];
  if (p.kind === 'extrusion') {
    const area = Math.abs(ringArea(p.footprint));
    if (selfCrossing(p.footprint)) out.push('the footprint crosses itself.');
    else if (area < 1e-6) out.push('the footprint has no area.');
  }
  if (p.kind === 'pipe' && pipeLength(p.points) < 1e-6) out.push('the pipe has no length.');
  const [x, , z] = partAnchor(p);
  if (Math.hypot(x, z) > FAR_FROM_ORIGIN_M) {
    out.push(`it lies more than ${String(FAR_FROM_ORIGIN_M / 1000)} km from the project origin.`);
  }
  return out;
}

/**
 * What a person should fix before building: an invalid file, a crossed or empty footprint, a
 * pipe without length, a part far off site, a tag on two parts. Empty when the model is good.
 */
export function checkProcModel(raw: unknown): ModelProblem[] {
  const parsed = ProcModel.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? first.path.join('.') : 'the top level';
    return [
      { message: `The model file is not valid at ${where}: ${first?.message ?? 'unknown'}.` },
    ];
  }
  const m = parsed.data;
  const out: ModelProblem[] = [];
  for (const p of m.parts) {
    for (const what of partProblems(p))
      out.push({ message: `Part "${p.id}": ${what}`, partId: p.id });
  }
  const byTag = new Map<string, string[]>();
  for (const p of m.parts) {
    if (!p.tag || p.status === 'rejected') continue;
    byTag.set(p.tag, [...(byTag.get(p.tag) ?? []), p.id]);
  }
  for (const [tag, ids] of byTag) {
    if (ids.length > 1) {
      out.push({ message: `Tag "${tag}" is on ${String(ids.length)} parts (${ids.join(', ')}).` });
    }
  }
  return out;
}
