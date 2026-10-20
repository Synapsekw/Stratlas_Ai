// Volume over time (pure): one row per capture date for a pile, and the stacked totals across piles.
import type { ComparisonResult } from '@aio/schema';

/** The date a per-date row is for (R16): its `to` capture, else its `from` one ('' without either). */
export const seriesDate = (r: Pick<ComparisonResult, 'toCapture' | 'fromCapture'>): string =>
  r.toCapture ?? r.fromCapture ?? '';

/** A per-date row's key, one per item and date: the app's store, the report and the assistant. */
export const seriesKeyOf = (
  r: Pick<ComparisonResult, 'item' | 'toCapture' | 'fromCapture'>,
): string => `${r.item} ${seriesDate(r)}`;

export interface TimeRow {
  capture: string;
  date: string;
  label: string;
  valueM3: number | null;
  changeM3: number | null;
  tonnes: number | null;
  status: ComparisonResult['status'] | 'missing';
  reason?: string;
  stale: boolean;
  latest: boolean;
}

export function volumeRows(
  series: readonly ComparisonResult[],
  captures: readonly { id: string; date: string; label: string }[],
  opts: {
    densityTPerM3?: number;
    isStale: (r: ComparisonResult) => boolean;
    quantity?: 'net' | 'total';
  },
): TimeRow[] {
  const sorted = [...captures].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1,
  );
  const rows: TimeRow[] = [];
  let prev: number | null = null;
  for (const c of sorted) {
    const r = series.find((x) => x.toCapture === c.id);
    const valueM3 =
      r !== undefined && r.status !== 'refused'
        ? opts.quantity === 'total'
          ? r.totalM3
          : r.netM3
        : null;
    rows.push({
      capture: c.id,
      date: c.date,
      label: c.label,
      valueM3,
      changeM3: valueM3 !== null && prev !== null ? valueM3 - prev : null,
      tonnes:
        valueM3 !== null && opts.densityTPerM3 !== undefined ? valueM3 * opts.densityTPerM3 : null,
      status: r ? r.status : 'missing',
      ...(r?.reason !== undefined ? { reason: r.reason } : {}),
      stale: r ? opts.isStale(r) : false,
      latest: false,
    });
    if (valueM3 !== null) prev = valueM3;
  }
  const latest = rows.findLast((r) => r.valueM3 !== null);
  if (latest) latest.latest = true;
  return rows;
}

/**
 * Why a pile's figure on a date is left out of that date's total: stale, no survey data (refused,
 * or absent on that date), not computed yet, the run failed, or the measurement has no comparison.
 */
export type NotCountedReason = 'stale' | 'no-data' | 'not-computed' | 'failed' | 'no-comparison';

export interface NotCounted {
  id: string;
  reason: NotCountedReason;
  /** The failure's own words, for `failed`. */
  detail?: string;
}

/** A total's change since an earlier date, over the piles counted on both (`piles` of `of`). */
export interface StackChange {
  m3: number;
  piles: number;
  of: number;
}

export interface StackRow {
  capture: string;
  date: string;
  label: string;
  totalM3: number;
  parts: { id: string; valueM3: number }[];
  /** Piles without survey data on this date. */
  missing: string[];
  /** Every pile left out of `totalM3`, with why (set by `inventorySeries`). */
  notCounted?: NotCounted[];
  /** Counted piles whose figure is partly outside the survey (set by `inventorySeries`). */
  partial?: string[];
  /** Cut and fill of the counted piles (set by `inventorySeries`). */
  cutM3?: number;
  fillM3?: number;
  /**
   * The change since the nearest earlier date with counted piles, over the piles counted on both;
   * null when they have none in common (set by `inventorySeries`).
   */
  change?: StackChange | null;
}

/** Sums the piles per capture date; a pile without a value on a date is listed in `missing`. */
export function stackRows(rows: ReadonlyMap<string, readonly TimeRow[]>): StackRow[] {
  const out = new Map<string, StackRow>();
  for (const [id, list] of rows)
    for (const r of list) {
      let s = out.get(r.capture);
      if (!s) {
        s = {
          capture: r.capture,
          date: r.date,
          label: r.label,
          totalM3: 0,
          parts: [],
          missing: [],
        };
        out.set(r.capture, s);
      }
      if (r.valueM3 === null) s.missing.push(id);
      else {
        s.parts.push({ id, valueM3: r.valueM3 });
        s.totalM3 += r.valueM3;
      }
    }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
