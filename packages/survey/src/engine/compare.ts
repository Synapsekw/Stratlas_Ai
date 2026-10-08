/**
 * The survey engine's TypeScript executor (ADR 0009, data-conventions section 26): one
 * comparison item over one polygon, the same arithmetic as the Python reference core
 * (`compare_item` in `aio_pipelines/survey/compare.py`). The shared fixtures hold the two to 1e-6
 * relative (`parity.test.ts`).
 *
 * - `dz = To - From`; fill where `dz > 0`, cut where `dz < 0`; net = fill - cut, total = fill + cut.
 * - Grid path (either side a grid surface): cells of the finer grid (or the item's `cellM`)
 *   aligned to it, in bands of 256 rows, each weighted by the exact share of it inside the polygon,
 *   both sides sampled at the cell centres; cells where a side has no data are uncovered.
 * - Exact path (both sides TINs, levels or planes): the polygon is integrated piece by piece;
 *   `cellM` is 0 in the result.
 * - The deadband only when `useDeadband`; above 2% uncovered `partial`, above 20% `refused`.
 * - The fingerprint hashes every input (see `fingerprint.ts`); results carry `engine: 'ts'`.
 *
 * Pure and worker-friendly: surfaces come from a `Resolve` function (prepared tiles fetched
 * through `aio://`, a design TIN, or the stockpile kit's grids in memory) and an `AbortSignal`
 * cancels a computation when the polygon is edited.
 */
import type { BaseSpec, ComparisonItem, ComparisonResult, SurfaceRef } from '@aio/schema';
import { buildBase, f3, Refused, TIN_STEP_M, type Samples } from './bases';
import { canonical, sha256Hex, type Json } from './fingerprint';
import {
  band,
  coverage,
  crossesItself,
  densify,
  normalRing,
  ringArea,
  signedArea,
  windowOver,
  type Window,
  type XY,
} from './geometry';
import { bilinear, checkSignal, sampleCells, type GridSurface } from './tiles';
import {
  earClip,
  exactCompare,
  HullExtension,
  rasterize,
  samplePoints,
  Tin,
  tinAt,
  tinExtremes,
  type ExactSide,
  type Planar,
  type TinFile,
} from './tin';

/** The executor's version; equal to the Python core's `ENGINE_VERSION`, part of every fingerprint. */
export const ENGINE_VERSION = 1;
export const PARTIAL_SHARE = 0.02;
export const REFUSE_SHARE = 0.2;
const BAND = 256;
const BASE_BOTH_SIDES = 'At least one side must be a surface: a base is sampled on the other side.';
const SURFACE_KINDS: readonly string[] = ['survey', 'current', 'previous', 'design'];

export const isSurface = (ref: { kind: string }): boolean => SURFACE_KINDS.includes(ref.kind);

/** A resolved surface side: a grid, or a TIN (absolute vertices, the offset not added). */
export type ResolvedSurface =
  | { kind: 'grid'; name: string; fingerprint: string; capture?: string; grid: GridSurface }
  | {
      kind: 'tin';
      name: string;
      fingerprint: string;
      capture?: string;
      tin: TinFile;
      offsetM: number;
    };

export type Resolve = (ref: SurfaceRef) => Promise<ResolvedSurface>;

/** What a result's fingerprint records of the site (from `SurveySettings`). */
export interface SiteContext {
  verticalDatum: Json;
  calibration?: string;
}

export interface CompareOptions {
  site?: SiteContext;
  signal?: AbortSignal;
  now?: () => string;
  /** Work shared between the items of one polygon (`compareItems` makes one). */
  shared?: Shared;
}

/** Coverage and surface samples of one polygon, reused by its items (same grid, same cells). */
export interface Shared {
  cover: Map<string, Float64Array>;
  cells: Map<string, Promise<Float64Array>>;
}

export const newShared = (): Shared => ({ cover: new Map(), cells: new Map() });

/** A failure to resolve a surface: the item is refused with this message. */
export class SurfaceMissing extends Error {}

// ------------------------------------------------------------------------------- fingerprint

function sideFp(ref: SurfaceRef, r: ResolvedSurface | null): Json {
  const out: Record<string, Json | undefined> = { ref };
  if (r) {
    out.surface = r.fingerprint;
    if (r.capture !== undefined) out.capture = r.capture;
    if (ref.kind === 'design' && r.kind === 'tin') out.offsetM = r.offsetM;
  }
  return out;
}

export async function fingerprint(
  ring: readonly XY[],
  item: ComparisonItem,
  rf: ResolvedSurface | null,
  rt: ResolvedSurface | null,
  site?: SiteContext,
): Promise<string> {
  const obj: Record<string, Json | undefined> = {
    engine: ENGINE_VERSION,
    ring: ring.map((p) => [p[0], p[1]]),
    from: sideFp(item.from, rf),
    to: sideFp(item.to, rt),
    deadbandM: item.deadbandM ?? 0,
    useDeadband: item.useDeadband,
    cellM: item.cellM,
    site: site as unknown as Json | undefined,
  };
  return `sha256:${await sha256Hex(canonical(obj))}`;
}

// ------------------------------------------------------------------------------------ labels

function baseWord(spec: BaseSpec): string {
  switch (spec.kind) {
    case 'reference':
      switch (spec.mode) {
        case 'level':
          return `Level ${f3(spec.levelM ?? 0)} m`;
        case 'perimeter-max':
          return 'Highest point on the perimeter';
        case 'perimeter-min':
          return 'Lowest point on the perimeter';
        case 'interior-max':
          return 'Highest point inside';
        case 'interior-min':
          return 'Lowest point inside';
      }
      break;
    case 'smart':
      return 'Smart base (triangulated perimeter)';
    case 'fit-plane':
      return 'Best-fit plane through the perimeter';
    case 'perimeter-mean':
      return 'Mean perimeter level';
    case 'custom':
      return `Custom base (${spec.vertices.length} vertices)`;
  }
  return 'Reference level';
}

export function sideLabel(ref: SurfaceRef, r: ResolvedSurface | null): string {
  switch (ref.kind) {
    case 'survey':
      return r ? r.name : `Survey ${ref.surface}`;
    case 'current':
      return r ? `Current survey (${r.name})` : 'Current survey';
    case 'previous':
      return r ? `Previous survey (${r.name})` : 'Previous survey';
    case 'design':
      if (!r) return `Design ${ref.design}, ${ref.layer}`;
      return r.kind === 'tin' && r.offsetM !== 0 ? `${r.name} (offset ${f3(r.offsetM)} m)` : r.name;
    default:
      return baseWord(ref);
  }
}

// ------------------------------------------------------------------------------------- sides

interface CellSide {
  cells(win: Window, need: Uint8Array | null, signal?: AbortSignal): Promise<Float64Array>;
  points(xs: Float64Array, ys: Float64Array): Promise<Float64Array>;
}

const winKey = (w: Window) => `${w.cell}/${w.i0}/${w.j0}/${w.nx}/${w.ny}`;

function gridSide(s: GridSurface, le: number, ln: number, key: string, shared?: Shared): CellSide {
  const de = le - s.originE;
  const dn = ln - s.originN;
  return {
    cells: (win, _need, signal) => {
      if (!shared) return sampleCells(s, de, dn, win, signal);
      const k = `${key}|${le},${ln}|${winKey(win)}`;
      let p = shared.cells.get(k);
      if (!p) {
        p = sampleCells(s, de, dn, win, signal);
        p.catch(() => shared.cells.delete(k));
        shared.cells.set(k, p);
      }
      return p;
    },
    points: (xs, ys) => bilinear(s, xs, ys, de, dn),
  };
}

function coverOf(lring: [number, number][], win: Window, le: number, ln: number, shared?: Shared) {
  if (!shared) return coverage(lring, win);
  const k = `${le},${ln}|${winKey(win)}`;
  let w = shared.cover.get(k);
  if (!w) {
    w = coverage(lring, win);
    shared.cover.set(k, w);
  }
  return w;
}

function tinSide(tin: Tin, extend: boolean): CellSide {
  const hull = extend ? new HullExtension(tin) : null;
  return {
    cells: (win, need, signal) => {
      const z = rasterize(tin, win, signal);
      if (hull && need) {
        const c = win.cell;
        for (let r = 0; r < win.ny; r++)
          for (let i = 0; i < win.nx; i++) {
            const k = r * win.nx + i;
            if (need[k] && Number.isNaN(z[k] ?? 0))
              z[k] = hull.z((win.i0 + i + 0.5) * c, (win.j0 + r + 0.5) * c);
          }
      }
      return Promise.resolve(z);
    },
    points: (xs, ys) => Promise.resolve(samplePoints(tin, xs, ys)),
  };
}

function planarSide(p: Planar): CellSide {
  return {
    cells: (win) => {
      const out = new Float64Array(win.nx * win.ny);
      const c = win.cell;
      if (p.level !== undefined) return Promise.resolve(out.fill(p.level));
      const pl = p.plane;
      for (let r = 0; r < win.ny; r++) {
        const y = (win.j0 + r + 0.5) * c;
        const at = r * win.nx;
        if (pl) {
          const [p0, p1, p2] = pl.p;
          const dy = p2 * (y - pl.oy);
          for (let i = 0; i < win.nx; i++)
            out[at + i] = p0 + p1 * ((win.i0 + i + 0.5) * c - pl.ox) + dy;
        } else for (let i = 0; i < win.nx; i++) out[at + i] = p.fn((win.i0 + i + 0.5) * c, y);
      }
      return Promise.resolve(out);
    },
    points: (xs, ys) => Promise.resolve(xs.map((x, k) => p.fn(x, ys[k] ?? 0))),
  };
}

function* bands(win: Window): Generator<Window> {
  for (let b0 = 0; b0 < win.ny; b0 += BAND) yield band(win, b0, BAND);
}

// -------------------------------------------------------------------------------------- core

interface Totals {
  fill: number;
  cut: number;
  areaFill: number;
  areaCut: number;
  areaUnchanged: number;
  uncovered: number;
}

/** The difference on the comparison grid, band by band (for heat maps and the kit's bodies). */
export interface GridOut {
  win: Window;
  le: number;
  ln: number;
  bands: { win: Window; dz: Float64Array; w: Float64Array }[];
}

function tinOf(r: ResolvedSurface, le: number, ln: number): Tin {
  if (r.kind !== 'tin') throw new Error('Not a TIN');
  return tinAt(r.tin, le, ln, r.offsetM);
}

/**
 * One `ComparisonResult` (`engine: 'ts'`) of `item` over the polygon `ring` (E, N, project CRS).
 * A surface that cannot be resolved refuses the item with its reason.
 */
export async function compareItem(
  ring: readonly (readonly number[])[],
  item: ComparisonItem,
  resolve: Resolve,
  opts: CompareOptions = {},
  gridOut?: GridOut[],
): Promise<ComparisonResult> {
  const { signal } = opts;
  const ringN = normalRing(ring);
  const from = item.from;
  const to = item.to;
  let rf: ResolvedSurface | null = null;
  let rt: ResolvedSurface | null = null;
  let problem: string | null = null;
  try {
    if (isSurface(from)) rf = await resolve(from);
    if (isSurface(to)) rt = await resolve(to);
  } catch (e) {
    if (e instanceof Error && e.name === 'EngineCancelled') throw e;
    problem = e instanceof Error ? e.message : String(e);
  }
  checkSignal(signal);
  const res: ComparisonResult = {
    item: item.id,
    status: 'ok',
    cutM3: 0,
    fillM3: 0,
    netM3: 0,
    totalM3: 0,
    areaM2: 0,
    areaCutM2: 0,
    areaFillM2: 0,
    areaUnchangedM2: 0,
    uncoveredM2: 0,
    fromLabel: sideLabel(from, rf),
    toLabel: sideLabel(to, rt),
    deadbandM: item.deadbandM ?? 0,
    usedDeadband: item.useDeadband,
    cellM: 0,
    engine: 'ts',
    fingerprint: await fingerprint(ringN, item, rf, rt, opts.site),
    computedAt: (opts.now ?? (() => new Date().toISOString()))(),
  };
  if (rf?.capture !== undefined) res.fromCapture = rf.capture;
  if (rt?.capture !== undefined) res.toCapture = rt.capture;
  const refuse = (reason: string, uncovered?: number): ComparisonResult =>
    Object.assign(res, {
      status: 'refused' as const,
      reason: reason.slice(0, 300),
      cutM3: 0,
      fillM3: 0,
      netM3: 0,
      totalM3: 0,
      areaCutM2: 0,
      areaFillM2: 0,
      areaUnchangedM2: 0,
      uncoveredM2: uncovered ?? res.areaM2,
    });
  if (problem) return refuse(problem);
  if (ringN.length < 3) return refuse('The polygon needs three or more points.');
  if (!isSurface(from) && !isSurface(to)) return refuse(BASE_BOTH_SIDES);

  const grids = [rt, rf].filter(
    (r): r is Extract<ResolvedSurface, { kind: 'grid' }> => r !== null && r.kind === 'grid',
  );
  let le: number;
  let ln: number;
  let cell = 0;
  let finest: Extract<ResolvedSurface, { kind: 'grid' }> | null = null;
  for (const g of grids) if (!finest || g.grid.cellM < finest.grid.cellM) finest = g;
  if (finest) {
    le = finest.grid.originE;
    ln = finest.grid.originN;
    cell = item.cellM ?? finest.grid.cellM;
  } else {
    const p0 = ringN[0] ?? [0, 0];
    le = p0[0];
    ln = p0[1];
  }
  const lring: [number, number][] = ringN.map(([e, n]) => [e - le, n - ln]);
  if (signedArea(lring) < 0) lring.reverse();
  const area = ringArea(lring);
  res.areaM2 = area;
  if (crossesItself(lring)) return refuse('The polygon crosses itself.');
  if (area <= 0) return refuse('The polygon has no area.');
  const deadband = item.deadbandM ?? 0;
  const useDb = item.useDeadband;
  const surf = isSurface(to) && !isSurface(from) ? rt : !isSurface(to) ? rf : null;
  let tot: Totals;
  let labels: { from?: string; to?: string };
  try {
    if (finest) {
      res.cellM = cell;
      [tot, labels] = await gridPath(
        lring,
        item,
        rf,
        rt,
        surf,
        { le, ln, cell, deadband, useDb },
        signal,
        opts.shared,
        gridOut,
      );
    } else {
      [tot, labels] = await exactPath(
        lring,
        item,
        rf,
        rt,
        surf,
        le,
        ln,
        useDb ? deadband : 0,
        signal,
      );
    }
  } catch (e) {
    if (e instanceof Refused) return refuse(e.message);
    throw e;
  }
  if (labels.from) res.fromLabel = labels.from;
  if (labels.to) res.toLabel = labels.to;
  const share = tot.uncovered / area;
  Object.assign(res, {
    cutM3: tot.cut,
    fillM3: tot.fill,
    netM3: tot.fill - tot.cut,
    totalM3: tot.fill + tot.cut,
    areaCutM2: tot.areaCut,
    areaFillM2: tot.areaFill,
    areaUnchangedM2: tot.areaUnchanged,
    uncoveredM2: tot.uncovered,
  });
  const pct = Math.floor(share * 100 + 0.5);
  if (share > REFUSE_SHARE) return refuse(`${pct}% outside the survey`, tot.uncovered);
  if (share > PARTIAL_SHARE) {
    res.status = 'partial';
    res.reason = `${pct}% outside the survey`;
  }
  return res;
}

function perimeterOf(
  lring: readonly XY[],
  step: number,
  points: (xs: Float64Array, ys: Float64Array) => Promise<Float64Array>,
): () => Promise<Samples> {
  let cached: Promise<Samples> | null = null;
  return () => {
    cached ??= (async () => {
      const { xs, ys } = densify(lring, step);
      const zs = await points(xs, ys);
      const keep: number[] = [];
      zs.forEach((z, k) => {
        if (Number.isFinite(z)) keep.push(k);
      });
      return {
        xs: Float64Array.from(keep, (k) => xs[k] ?? 0),
        ys: Float64Array.from(keep, (k) => ys[k] ?? 0),
        zs: Float64Array.from(keep, (k) => zs[k] ?? 0),
      };
    })();
    return cached;
  };
}

async function gridPath(
  lring: [number, number][],
  item: ComparisonItem,
  rf: ResolvedSurface | null,
  rt: ResolvedSurface | null,
  surf: ResolvedSurface | null,
  g: { le: number; ln: number; cell: number; deadband: number; useDb: boolean },
  signal: AbortSignal | undefined,
  shared: Shared | undefined,
  gridOut: GridOut[] | undefined,
): Promise<[Totals, { from?: string; to?: string }]> {
  const { le, ln, cell, deadband, useDb } = g;
  const win = windowOver(lring, cell);
  const sideOf = (r: ResolvedSurface): CellSide =>
    r.kind === 'grid'
      ? gridSide(r.grid, le, ln, `${r.fingerprint}|${r.capture ?? ''}`, shared)
      : tinSide(tinOf(r, le, ln), false);
  const sides: { from?: CellSide; to?: CellSide } = {};
  const labels: { from?: string; to?: string } = {};
  if (rf) sides.from = sideOf(rf);
  if (rt) sides.to = sideOf(rt);
  if (surf) {
    const name = surf === rt ? 'from' : 'to';
    const s = surf === rt ? sides.to : sides.from;
    if (!s) throw new Error('No surface side');
    const interior = async (): Promise<[number, number] | null> => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const sub of bands(win)) {
        const w = coverOf(lring, sub, le, ln, shared);
        const z = await s.cells(sub, null, signal);
        for (let k = 0; k < w.length; k++) {
          const v = z[k] ?? NaN;
          if ((w[k] ?? 0) > 0 && Number.isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      return lo === Infinity ? null : [lo, hi];
    };
    const spec = item[name] as BaseSpec;
    const [base, label] = await buildBase(spec, {
      ring: lring,
      perimeter: perimeterOf(lring, cell, (xs, ys) => s.points(xs, ys)),
      interior,
      atPoints: (xs, ys) => s.points(xs, ys),
      toLocal: (e, n) => [e - le, n - ln],
    });
    sides[name] = base instanceof Tin ? tinSide(base, true) : planarSide(base);
    labels[name] = label;
  }
  const sf = sides.from;
  const st = sides.to;
  if (!sf || !st) throw new Error('A side is missing');
  const tot: Totals = { fill: 0, cut: 0, areaFill: 0, areaCut: 0, areaUnchanged: 0, uncovered: 0 };
  const out: GridOut | null = gridOut ? { win, le, ln, bands: [] } : null;
  let fill = 0;
  let cut = 0;
  let aFill = 0;
  let aCut = 0;
  let aUn = 0;
  let unc = 0;
  for (const sub of bands(win)) {
    checkSignal(signal);
    const w = coverOf(lring, sub, le, ln, shared);
    const need = new Uint8Array(w.length);
    for (let k = 0; k < w.length; k++) need[k] = (w[k] ?? 0) > 0 ? 1 : 0;
    const zf = await sf.cells(sub, need, signal);
    const zt = await st.cells(sub, need, signal);
    const dzOut = out ? new Float64Array(w.length).fill(NaN) : null;
    for (let k = 0; k < w.length; k++) {
      const wk = w[k] ?? 0;
      if (wk <= 0) continue;
      const a = zf[k] ?? NaN;
      const b = zt[k] ?? NaN;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        unc += wk;
        continue;
      }
      const dz = b - a;
      if (dzOut) dzOut[k] = dz;
      const counts = !useDb || Math.abs(dz) >= deadband;
      if (counts && dz > 0) {
        fill += wk * dz;
        aFill += wk;
      } else if (counts && dz < 0) {
        cut -= wk * dz;
        aCut += wk;
      } else aUn += wk;
    }
    if (out && dzOut) out.bands.push({ win: sub, dz: dzOut, w });
  }
  const a2 = cell * cell;
  tot.fill = fill * a2;
  tot.cut = cut * a2;
  tot.areaFill = aFill * a2;
  tot.areaCut = aCut * a2;
  tot.areaUnchanged = aUn * a2;
  tot.uncovered = unc * a2;
  if (out && gridOut) gridOut.push(out);
  return [tot, labels];
}

async function exactPath(
  lring: [number, number][],
  item: ComparisonItem,
  rf: ResolvedSurface | null,
  rt: ResolvedSurface | null,
  surf: ResolvedSurface | null,
  le: number,
  ln: number,
  db: number,
  signal: AbortSignal | undefined,
): Promise<[Totals, { from?: string; to?: string }]> {
  const ptris = earClip(lring);
  const sides: { from?: ExactSide; to?: ExactSide } = {};
  const labels: { from?: string; to?: string } = {};
  if (rf) sides.from = tinOf(rf, le, ln);
  if (rt) sides.to = tinOf(rt, le, ln);
  if (surf) {
    const name = surf === rt ? 'from' : 'to';
    const sTin = (surf === rt ? sides.to : sides.from) as Tin;
    const step = item.cellM ?? TIN_STEP_M;
    const points = (xs: Float64Array, ys: Float64Array) =>
      Promise.resolve(samplePoints(sTin, xs, ys));
    const [base, label] = await buildBase(item[name] as BaseSpec, {
      ring: lring,
      perimeter: perimeterOf(lring, step, points),
      interior: () => Promise.resolve(tinExtremes(ptris, sTin)),
      atPoints: points,
      toLocal: (e, n) => [e - le, n - ln],
    });
    sides[name] = base;
    labels[name] = label;
  }
  if (!sides.from || !sides.to) throw new Error('A side is missing');
  const ex = exactCompare(ptris, sides.from, sides.to, db, signal);
  const area = ringArea(lring);
  return [
    {
      fill: ex.fill,
      cut: ex.cut,
      areaFill: ex.areaFill,
      areaCut: ex.areaCut,
      areaUnchanged: ex.areaUnchanged,
      uncovered: Math.max(area - ex.covered, 0),
    },
    labels,
  ];
}

/**
 * Every item of one polygon (a measurement's comparisons), in order. Resolved surfaces are shared
 * through `resolve` (cache them there); a cancelled signal stops at the next band.
 */
export async function compareItems(
  ring: readonly (readonly number[])[],
  items: readonly ComparisonItem[],
  resolve: Resolve,
  opts: CompareOptions = {},
): Promise<ComparisonResult[]> {
  const out: ComparisonResult[] = [];
  const shared = opts.shared ?? newShared();
  for (const it of items) out.push(await compareItem(ring, it, resolve, { ...opts, shared }));
  return out;
}

export { f3, Refused, TIN_STEP_M };
