/**
 * Cross-sections (M11 G5, data-conventions section 27): any number of surfaces sampled along a
 * polyline, the way section 26 samples heights. Prepared survey surfaces are sampled bilinearly
 * between their posts (`bilinear` of the engine); design TINs barycentrically through
 * `TinSampler`, their vertical offset added. `aio_pipelines/survey/section.py` does the same
 * arithmetic for `survey.section` (DXF and CSV) and the parity fixture holds the two together.
 *
 * **Stations.** Each segment of the line of length `L` is cut into `max(1, ceil(L / step - 1e-9))`
 * equal parts; the stations are the start of each part, then the line's last vertex. So every
 * vertex is a station and stations are at most `step` apart. The default step is half the finest
 * grid cell of the surfaces (0.5 m with TINs only), widened so a section never has more than
 * `MAX_STATIONS`.
 *
 * Heights are `null` where a surface has no data (outside it or a needed post without data).
 */
import { TinHeader, type SectionProfile, type SectionSpec } from '@aio/schema';
import type { Resolve, ResolvedSurface } from '../engine/compare';
import { checkSignal, bilinear } from '../engine/tiles';
import type { TinFile } from '../engine/tin';
import { TinSampler, type Tin as DesignTin } from '../designs/tin';

export type SectionRef = SectionSpec['surfaces'][number];
export type XY = readonly [number, number];

/** Heights at site points (E, N), NaN where the surface has no data. */
export type PointSampler = (
  es: Float64Array,
  ns: Float64Array,
  signal?: AbortSignal,
) => Promise<Float64Array>;

/** A surface ready to sample: its key, label and sampler. */
export interface SectionSurface {
  key: string;
  label: string;
  ref: SectionRef;
  /** Grid cell, metres (absent for a TIN). */
  cellM?: number;
  sample: PointSampler;
}

/** The step used when only TINs are sampled, metres. */
export const SECTION_TIN_STEP_M = 0.5;
/** Stations per section at most (the step widens beyond). */
export const MAX_STATIONS = 100_000;

/** A stable key for a surface reference (`survey:<id>`, `design:<d>/<l>`, `current`...). */
export function surfaceKey(ref: SectionRef): string {
  switch (ref.kind) {
    case 'survey':
      return `survey:${ref.surface}`;
    case 'design':
      return `design:${ref.design}/${ref.layer}`;
    default:
      return ref.kind;
  }
}

const tinSamplers = new WeakMap<TinFile, Map<number, TinSampler>>();

/** A TIN file of the engine as `TinSampler` reads it (bounds from the vertices when needed). */
function designTin(f: TinFile): DesignTin {
  const v = f.vertices;
  let e0 = Infinity;
  let n0 = Infinity;
  let z0 = Infinity;
  let e1 = -Infinity;
  let n1 = -Infinity;
  let z1 = -Infinity;
  for (let k = 0; k + 2 < v.length; k += 3) {
    const e = v[k] ?? 0;
    const n = v[k + 1] ?? 0;
    const z = v[k + 2] ?? 0;
    if (e < e0) e0 = e;
    if (e > e1) e1 = e;
    if (n < n0) n0 = n;
    if (n > n1) n1 = n;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const bounds: [number, number, number, number, number, number] =
    e0 === Infinity ? [0, 0, 0, 0, 0, 0] : [e0, n0, z0, e1, n1, z1];
  const parsed = TinHeader.safeParse(f.header);
  const header: TinHeader = parsed.success
    ? { ...parsed.data, bounds }
    : {
        schema: 'aio.tin/1',
        crs: { epsg: 4326 },
        bounds,
        vertexCount: v.length / 3,
        triangleCount: f.triangles.length / 3,
        verticesAt: 8,
        trianglesAt: 8,
      };
  return { header, vertices: v, triangles: f.triangles, chains: [] };
}

/** The sampler of a resolved surface: bilinear for a grid, barycentric (offset added) for a TIN. */
export function samplerOf(r: ResolvedSurface): { sample: PointSampler; cellM?: number } {
  if (r.kind === 'grid') {
    const g = r.grid;
    return {
      cellM: g.cellM,
      sample: (es, ns, signal) => bilinear(g, es, ns, -g.originE, -g.originN, signal),
    };
  }
  let byOffset = tinSamplers.get(r.tin);
  if (!byOffset) {
    byOffset = new Map();
    tinSamplers.set(r.tin, byOffset);
  }
  let s = byOffset.get(r.offsetM);
  if (!s) {
    s = new TinSampler(designTin(r.tin), r.offsetM);
    byOffset.set(r.offsetM, s);
  }
  const sampler = s;
  return {
    sample: (es, ns, signal) => {
      checkSignal(signal);
      const out = new Float64Array(es.length);
      for (let k = 0; k < es.length; k++) out[k] = sampler.sample(es[k] ?? 0, ns[k] ?? 0) ?? NaN;
      return Promise.resolve(out);
    },
  };
}

/** The label of a section surface (as the comparison engine words a side). */
export function sectionLabel(ref: SectionRef, r: ResolvedSurface | null): string {
  switch (ref.kind) {
    case 'survey':
      return r ? r.name : `Survey ${ref.surface}`;
    case 'current':
      return r ? `Current survey (${r.name})` : 'Current survey';
    case 'previous':
      return r ? `Previous survey (${r.name})` : 'Previous survey';
    default: {
      if (!r) return `Design ${ref.design}, ${ref.layer}`;
      const off = r.kind === 'tin' ? r.offsetM : 0;
      return off !== 0 ? `${r.name} (offset ${String(Math.round(off * 1000) / 1000)} m)` : r.name;
    }
  }
}

/** Resolve the section's surfaces; those that cannot be resolved are returned with the reason. */
export async function resolveSection(
  refs: readonly SectionRef[],
  resolve: Resolve,
): Promise<{ surfaces: SectionSurface[]; missing: { ref: SectionRef; reason: string }[] }> {
  const surfaces: SectionSurface[] = [];
  const missing: { ref: SectionRef; reason: string }[] = [];
  for (const ref of refs) {
    try {
      const r = await resolve(ref);
      const s = samplerOf(r);
      surfaces.push({
        key: surfaceKey(ref),
        label: sectionLabel(ref, r),
        ref,
        ...(s.cellM !== undefined ? { cellM: s.cellM } : {}),
        sample: s.sample,
      });
    } catch (e) {
      missing.push({ ref, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { surfaces, missing };
}

// ------------------------------------------------------------------------------------ stations

/** Horizontal length of a polyline. */
export function lineLength(line: readonly XY[]): number {
  let s = 0;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    if (a && b) s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

/** The point (E, N) at a chainage along the line (clamped to its ends) and the segment's unit. */
export function pointAtChainage(
  line: readonly XY[],
  chainage: number,
): { e: number; n: number; ue: number; un: number } {
  let rest = Math.max(0, chainage);
  let last = { e: line[0]?.[0] ?? 0, n: line[0]?.[1] ?? 0, ue: 1, un: 0 };
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const ue = (b[0] - a[0]) / len;
    const un = (b[1] - a[1]) / len;
    if (rest <= len) return { e: a[0] + ue * rest, n: a[1] + un * rest, ue, un };
    rest -= len;
    last = { e: b[0], n: b[1], ue, un };
  }
  return last;
}

/** The default step: half the finest grid cell (SECTION_TIN_STEP_M with TINs only). */
export function defaultStep(surfaces: readonly { cellM?: number }[]): number {
  let cell = Infinity;
  for (const s of surfaces) if (s.cellM !== undefined && s.cellM < cell) cell = s.cellM;
  return cell === Infinity ? SECTION_TIN_STEP_M : cell / 2;
}

export interface Stations {
  step: number;
  length: number;
  chainage: Float64Array;
  e: Float64Array;
  n: Float64Array;
}

/** Stations along the line every `step` at most, every vertex included (see the module note). */
export function stations(line: readonly XY[], step: number): Stations {
  const length = lineLength(line);
  const st = Math.max(step, length / (MAX_STATIONS - 1));
  const ch: number[] = [];
  const es: number[] = [];
  const ns: number[] = [];
  let run = 0;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    if (!a || !b) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const m = Math.max(1, Math.ceil(len / st - 1e-9));
    for (let s = 0; s < m; s++) {
      ch.push(run + (len * s) / m);
      es.push(a[0] + ((b[0] - a[0]) * s) / m);
      ns.push(a[1] + ((b[1] - a[1]) * s) / m);
    }
    run += len;
  }
  const end = line[line.length - 1];
  if (end) {
    ch.push(run);
    es.push(end[0]);
    ns.push(end[1]);
  }
  return {
    step: st,
    length,
    chainage: Float64Array.from(ch),
    e: Float64Array.from(es),
    n: Float64Array.from(ns),
  };
}

// ------------------------------------------------------------------------------------- section

export interface Section extends Stations {
  line: XY[];
  profiles: SectionProfile[];
}

const nullable = (h: Float64Array): (number | null)[] =>
  Array.from(h, (v) => (Number.isFinite(v) ? v : null));

/** Sample every surface along the line (`stepM` default: half the finest grid cell). */
export async function sampleSection(
  spec: { line: readonly XY[]; stepM?: number },
  surfaces: readonly SectionSurface[],
  signal?: AbortSignal,
): Promise<Section> {
  if (spec.line.length < 2) throw new RangeError('A section line needs two points or more.');
  const st = stations(spec.line, spec.stepM ?? defaultStep(surfaces));
  const profiles: SectionProfile[] = [];
  for (const s of surfaces) {
    checkSignal(signal);
    const h = await s.sample(st.e, st.n, signal);
    profiles.push({
      surface: s.key,
      label: s.label,
      chainage: Array.from(st.chainage),
      z: nullable(h),
    });
  }
  return { ...st, line: spec.line.map((p) => [p[0], p[1]] as const), profiles };
}

// ----------------------------------------------------------------------------- grades and pins

/** A grade: rise over run, in percent, in degrees and as 1:n (run per unit rise). */
export interface Grade {
  /** Rise over run (signed, along the chainage). */
  ratio: number;
  percent: number;
  degrees: number;
  /** n of 1:n (Infinity on the flat). */
  oneIn: number;
}

export function gradeOf(rise: number, run: number): Grade {
  const ratio = rise / run;
  return {
    ratio,
    percent: ratio * 100,
    degrees: (Math.atan(ratio) * 180) / Math.PI,
    oneIn: ratio === 0 ? Infinity : 1 / Math.abs(ratio),
  };
}

export interface PinValue {
  key: string;
  label: string;
  /** Elevation at the pin, metres; null where the surface has no data. */
  z: number | null;
  /** `z` minus the reference surface's `z`; null without either. */
  delta: number | null;
  /** The grade along the section at the pin; null where either side has no data. */
  grade: Grade | null;
}

export interface Pin {
  chainage: number;
  e: number;
  n: number;
  /** Index of the surface the deltas are taken from. */
  reference: number;
  values: PinValue[];
}

/**
 * A pin at a chainage: each surface sampled at the pin itself (not read off the profile), its
 * delta to the reference surface and its grade by a central difference over `±h` along the line
 * (one-sided at the ends; `h` default half the step).
 */
export async function pinAt(
  line: readonly XY[],
  chainage: number,
  surfaces: readonly SectionSurface[],
  opts: { reference?: number; h?: number; signal?: AbortSignal } = {},
): Promise<Pin> {
  const length = lineLength(line);
  const c = Math.min(Math.max(chainage, 0), length);
  const h = opts.h ?? defaultStep(surfaces) / 2;
  const c0 = Math.max(0, c - h);
  const c1 = Math.min(length, c + h);
  const p = pointAtChainage(line, c);
  const a = pointAtChainage(line, c0);
  const b = pointAtChainage(line, c1);
  const es = Float64Array.from([p.e, a.e, b.e]);
  const ns = Float64Array.from([p.n, a.n, b.n]);
  const raw: { z: number | null; grade: Grade | null }[] = [];
  for (const s of surfaces) {
    const z = await s.sample(es, ns, opts.signal);
    const z0 = z[0] ?? NaN;
    const za = z[1] ?? NaN;
    const zb = z[2] ?? NaN;
    raw.push({
      z: Number.isFinite(z0) ? z0 : null,
      grade:
        Number.isFinite(za) && Number.isFinite(zb) && c1 > c0 ? gradeOf(zb - za, c1 - c0) : null,
    });
  }
  const reference = Math.min(Math.max(opts.reference ?? 0, 0), Math.max(0, surfaces.length - 1));
  const zr = raw[reference]?.z ?? null;
  return {
    chainage: c,
    e: p.e,
    n: p.n,
    reference,
    values: surfaces.map((s, i) => {
      const z = raw[i]?.z ?? null;
      return {
        key: s.key,
        label: s.label,
        z,
        delta: z !== null && zr !== null ? z - zr : null,
        grade: raw[i]?.grade ?? null,
      };
    }),
  };
}
