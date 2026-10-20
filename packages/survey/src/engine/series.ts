/**
 * Volume per survey date and the spread across bases (volumetric parity W3 and W4), the same as
 * the Python core's `aio_pipelines/survey/series.py`; the shared fixtures (`series.json`) hold the
 * two together (ADR 0009, `series.parity.test.ts`).
 *
 * - **Per date** (`compareSeries`): one item run once per capture, with that capture as `current`
 *   and, as `previous`, the capture with a prepared surface before it (`projectResolver` viewed on
 *   that capture). A fixed side (a survey with a capture, a design, a base) stays fixed. The
 *   `current` side's capture is always the date, also when the date is refused before its surface
 *   is resolved.
 * - **Spread across bases** (`baseSpread`): an item whose `from` is a base, run with each of
 *   `SPREAD_BASES` in its place; over the ok or partial results,
 *   `pct = (max(totalM3) - min(totalM3)) / 2 / mean(totalM3) * 100`. The card shows it as
 *   "±{pct} across bases" with one decimal.
 */
import type { BaseSpec, ComparisonItem, ComparisonResult } from '@aio/schema';
import { compareItem, isSurface, newShared, type CompareOptions, type Resolve } from './compare';

/** A polygon as stored: `[E, N]` points in the project CRS (the last need not repeat the first). */
export type Ring = readonly (readonly number[])[];

/** The bases the spread is taken over: smart, best-fit plane, mean perimeter level, lowest perimeter. */
export const SPREAD_BASES: readonly BaseSpec[] = [
  { kind: 'smart' },
  { kind: 'fit-plane' },
  { kind: 'perimeter-mean' },
  { kind: 'reference', mode: 'perimeter-min' },
];

/** A mean total below a cubic centimetre counts as 0 (a base on flat ground leaves float noise). */
export const MEAN_ZERO_M3 = 1e-6;

const DATE_KINDS: readonly string[] = ['current', 'previous'];

/** True when either side follows the date (`current` or `previous`). */
export function seriesApplies(item: ComparisonItem): boolean {
  return DATE_KINDS.includes(item.from.kind) || DATE_KINDS.includes(item.to.kind);
}

/**
 * Runs `item` once per capture with that capture as "current" (and "previous" as the one before it).
 * A fixed side (a survey with a capture, a design, a base) stays fixed. Each result has toCapture or
 * fromCapture set to the date; results come back in the order of `captures`.
 */
export async function compareSeries(
  ring: Ring,
  item: ComparisonItem,
  resolveAt: (capture: string) => Resolve,
  captures: readonly string[],
  opts: CompareOptions = {},
): Promise<ComparisonResult[]> {
  const shared = opts.shared ?? newShared();
  const out: ComparisonResult[] = [];
  for (const cap of captures) {
    const r = await compareItem(ring, item, resolveAt(cap), { ...opts, shared });
    if (item.from.kind === 'current') r.fromCapture = cap;
    if (item.to.kind === 'current') r.toCapture = cap;
    out.push(r);
  }
  return out;
}

/** The spread of an item's volume across `SPREAD_BASES`, and each base's net volume. */
export interface BaseSpread {
  /** `(max - min) / 2 / mean` of the total volumes, in percent. */
  pct: number;
  /** Per base that gave an ok or partial result: its short name and net volume. */
  nets: { base: string; netM3: number }[];
}

/** A base's short name in a spread: its kind, or a reference base's mode. */
const baseKey = (b: BaseSpec): string => (b.kind === 'reference' ? b.mode : b.kind);

/** null when the item's `from` is not a base, or fewer than 2 bases give an ok or partial result, or the mean is 0. */
export async function baseSpread(
  ring: Ring,
  item: ComparisonItem,
  resolve: Resolve,
  opts: CompareOptions = {},
): Promise<BaseSpread | null> {
  if (isSurface(item.from)) return null;
  const shared = opts.shared ?? newShared();
  const totals: number[] = [];
  const nets: BaseSpread['nets'] = [];
  for (const b of SPREAD_BASES) {
    const r = await compareItem(ring, { ...item, from: b }, resolve, { ...opts, shared });
    if (r.status === 'ok' || r.status === 'partial') {
      totals.push(r.totalM3);
      nets.push({ base: baseKey(b), netM3: r.netM3 });
    }
  }
  if (totals.length < 2) return null;
  let total = 0;
  for (const t of totals) total += t;
  const mean = total / totals.length;
  if (mean < MEAN_ZERO_M3) return null;
  return { pct: ((Math.max(...totals) - Math.min(...totals)) / 2 / mean) * 100, nets };
}
