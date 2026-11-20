/**
 * A pile's base as heights at points: the base its first comparison names (`buildBase`, the
 * engine's own), sampled on the ground a caller gives, and the boundary's own heights where no
 * base can be built. One copy for the opened pile's box (`pileLookScene`) and for the report's
 * pile profile, so both draw the same base line.
 *
 * Pure but for the ground sampler it is handed: site coordinates (E, N) in, heights out.
 */
import { isSurfaceSide, type BaseSpec, type SitePoint, type SurveyMeasurement } from '@aio/schema';
import { buildBase, densify, samplePoints, Tin } from '@aio/survey';
import { ringBase } from './pileLook';

/** The ground height under each point, NaN where there is no survey. */
export type PointsAt = (es: Float64Array, ns: Float64Array) => Promise<Float64Array>;

/** A built base: its height at each point, NaN where it has none. */
export type BaseAt = (es: Float64Array, ns: Float64Array) => Float64Array;

export interface PileBaseInput {
  spec: BaseSpec;
  /** The pile's boundary where it is drawn (site coordinates). */
  ring: readonly SitePoint[];
  /** The step the boundary's edge is sampled at, metres. */
  step: number;
  /** The ground the base is sampled on. */
  at: PointsAt;
  /** The lowest and highest ground height inside the boundary, null with no survey there. */
  interior: () => [number, number] | null;
}

/** The pile's base as its first comparison has it (a surface side: the smart base). */
export function baseSpecOf(m: Pick<SurveyMeasurement, 'items'>): BaseSpec {
  const from = m.items[0]?.from;
  return from && !isSurfaceSide(from) ? (from as BaseSpec) : { kind: 'smart' };
}

/** The lowest and highest finite height, null when there is none. */
export function heightExtent(zs: ArrayLike<number>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of Array.from(zs)) {
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return lo === Infinity ? null : [lo, hi];
}

/**
 * Build the pile's base on the given ground. Null when it cannot be built (no survey under the
 * edge yet): the boundary's own heights then stand in (`pileBaseHeights`).
 */
export async function buildPileBase(inp: PileBaseInput): Promise<BaseAt | null> {
  const { ring, at } = inp;
  // the base in metres from the boundary box's corner (the engine's own local frame)
  let le = Infinity;
  let ln = Infinity;
  for (const p of ring) {
    le = Math.min(le, p[0]);
    ln = Math.min(ln, p[1]);
  }
  const lring = ring.map((p): [number, number] => [p[0] - le, p[1] - ln]);
  try {
    const [b] = await buildBase(inp.spec, {
      ring: lring,
      perimeter: async () => {
        const d = densify(lring, inp.step);
        const z = await at(
          d.xs.map((x) => x + le),
          d.ys.map((y) => y + ln),
        );
        const keep: number[] = [];
        z.forEach((v, k) => {
          if (Number.isFinite(v)) keep.push(k);
        });
        return {
          xs: Float64Array.from(keep, (k) => d.xs[k] ?? 0),
          ys: Float64Array.from(keep, (k) => d.ys[k] ?? 0),
          zs: Float64Array.from(keep, (k) => z[k] ?? 0),
        };
      },
      interior: () => Promise.resolve(inp.interior()),
      atPoints: (xs, ys) =>
        at(
          xs.map((x) => x + le),
          ys.map((y) => y + ln),
        ),
      toLocal: (e, n) => [e - le, n - ln],
    });
    return (es, ns) => {
      const xs = es.map((e) => e - le);
      const ys = ns.map((n) => n - ln);
      if (b instanceof Tin) return samplePoints(b, xs, ys);
      const out = new Float64Array(xs.length);
      for (let k = 0; k < xs.length; k++) out[k] = b.fn(xs[k] ?? 0, ys[k] ?? 0);
      return out;
    };
  } catch {
    return null;
  }
}

/**
 * The base under each point: the pile's base where it has one, else the boundary's own heights
 * (inside the boundary), else NaN.
 */
export async function pileBaseHeights(
  inp: PileBaseInput,
  es: Float64Array,
  ns: Float64Array,
): Promise<Float64Array> {
  const base = await buildPileBase(inp);
  const out = base ? base(es, ns) : new Float64Array(es.length).fill(Number.NaN);
  const fallback = ringBase(inp.ring);
  for (let k = 0; k < out.length; k++) {
    if (Number.isFinite(out[k] ?? Number.NaN)) continue;
    out[k] = fallback(es[k] ?? 0, ns[k] ?? 0) ?? Number.NaN;
  }
  return out;
}
