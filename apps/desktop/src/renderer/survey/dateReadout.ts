// Readout rows on a survey date's surface: the tools ask a synchronous height sampler, the date's
// prepared surface is sampled asynchronously. Shared by the report page and the measurement panel,
// so the numbers match.
import type { SurveyMeasurement } from '@aio/schema';
import { measurementReadout, type PointSampler, type ReadoutRow } from '@aio/survey';

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
