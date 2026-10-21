// Readout rows on a survey date's surface: the tools ask a synchronous height sampler, the date's
// prepared surface is sampled asynchronously. Shared by the report page and the measurement panel,
// so the numbers match.
import { shiftEN, type DateShift, type HeightTiles, type SurveyMeasurement } from '@aio/schema';
import { measurementReadout, type PointSampler, type ReadoutRow } from '@aio/survey';

/** The line-up a prepared surface's cells sit at: its `dateShiftM` with its `dateTurn`. */
export function preparedShift(s: HeightTiles | null, origin: readonly number[]): DateShift | null {
  if (!s || (!s.dateShiftM && !s.dateTurn)) return null;
  const out: DateShift = { eastM: s.dateShiftM?.eastM ?? 0, northM: s.dateShiftM?.northM ?? 0 };
  const turn = s.dateTurn;
  if (turn)
    out.turn = {
      ...turn,
      pivotX: turn.pivotE - (origin[0] ?? 0),
      pivotZ: (origin[1] ?? 0) - turn.pivotN,
    };
  return out;
}

/**
 * A sampler of a date's surface for stored points (the date's line-up now taken off): moved on by
 * the line-up the surface was prepared with, as the panel's `drawnSampler` does for drawn points.
 * The sampler itself when the surface was prepared with none.
 */
export function onPreparedSurface(
  sample: PointSampler,
  surface: HeightTiles | null,
  origin: readonly number[],
): PointSampler {
  const s = preparedShift(surface, origin);
  if (!s) return sample;
  return (es, ns, signal) => {
    const e = new Float64Array(es.length);
    const n = new Float64Array(es.length);
    for (let i = 0; i < es.length; i++) {
      const p = shiftEN([es[i] ?? 0, ns[i] ?? 0], s);
      e[i] = p[0] ?? 0;
      n[i] = p[1] ?? 0;
    }
    return sample(e, n, signal);
  };
}

/**
 * The readout rows with terrain values from an async sampler: the points the tools ask for are
 * collected first (every height 0), sampled in one go, then the tools are asked again with the
 * answers. Without a sampler the rows are those without a surface.
 */
export async function readoutOn(
  m: SurveyMeasurement,
  items: readonly string[] | undefined,
  sample: PointSampler | null,
  ctx: { stepM?: number } = {},
): Promise<ReadoutRow[]> {
  const step = ctx.stepM === undefined ? {} : { stepM: ctx.stepM };
  if (!sample) return measurementReadout(m, step, items);
  const es: number[] = [];
  const ns: number[] = [];
  measurementReadout(
    m,
    {
      ...step,
      surface: {
        heightAt: (e, n) => {
          es.push(e);
          ns.push(n);
          return 0;
        },
      },
    },
    items,
  );
  const hs = es.length
    ? await sample(Float64Array.from(es), Float64Array.from(ns))
    : new Float64Array();
  const at = new Map<string, number>();
  es.forEach((e, i) => at.set(`${String(e)},${String(ns[i])}`, hs[i] ?? Number.NaN));
  return measurementReadout(
    m,
    {
      ...step,
      surface: {
        heightAt: (e, n) => {
          const h = at.get(`${String(e)},${String(n)}`);
          return h === undefined || !Number.isFinite(h) ? null : h;
        },
      },
    },
    items,
  );
}
