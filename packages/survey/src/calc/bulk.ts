import type {
  ComparisonItem,
  ComparisonResult,
  SurfaceRef,
  SurveyMeasurement,
  UnitsOverride,
} from '@aio/schema';
import { isBase, sideKey } from './pickers';
import { seriesDate, volumeRows, type StackRow, type TimeRow } from './timeline';

/**
 * Bulk selection (M11 G4, PRD SRV-1): running totals across the selected measurements of one
 * template, and one change (a surface or the units) applied to all of them at once. Totals add
 * only current results: a stale, refused or missing result is counted and named, never added.
 */

export interface BulkRow {
  /** The item's position in each measurement (items of one template line up by position). */
  index: number;
  label: string;
  cutM3: number;
  fillM3: number;
  netM3: number;
  totalM3: number;
  areaM2: number;
  /** Measurements whose result for this item was added. */
  counted: number;
  /** Measurements whose result is missing, stale or refused (not added). */
  missing: number;
}

export interface BulkTotals {
  /** The template the selection shares (`null` for measurements without one). */
  template: string | null;
  /** The selection holds measurements of more than one template. */
  mixed: boolean;
  measurements: number;
  rows: BulkRow[];
  /** Horizontal area of every polygon in the selection, square metres. */
  areaM2: number;
}

const itemLabel = (it: ComparisonItem | undefined, index: number) =>
  it?.label ?? `Comparison ${String(index + 1)}`;

/**
 * Totals per comparison item across `selected`. `polygonArea` gives a measurement's horizontal
 * area (the tools' `polygonAreas`), so the selection's area is one number too.
 */
export function bulkTotals(
  selected: readonly SurveyMeasurement[],
  polygonArea: (m: SurveyMeasurement) => number,
  isCurrent: (m: SurveyMeasurement, itemId: string) => boolean = () => true,
): BulkTotals {
  const templates = new Set(selected.map((m) => m.template ?? null));
  const mixed = templates.size > 1;
  const template = templates.size === 1 ? ([...templates][0] ?? null) : null;
  const rows: BulkRow[] = [];
  let areaM2 = 0;
  for (const m of selected) {
    if (m.family === 'polygon') areaM2 += polygonArea(m);
    m.items.forEach((it, i) => {
      let row = rows[i];
      if (!row) {
        row = {
          index: i,
          label: itemLabel(it, i),
          cutM3: 0,
          fillM3: 0,
          netM3: 0,
          totalM3: 0,
          areaM2: 0,
          counted: 0,
          missing: 0,
        };
        rows[i] = row;
      }
      const r = m.results.find((x) => x.item === it.id);
      if (!r || r.status === 'stale' || r.status === 'refused' || !isCurrent(m, it.id)) {
        row.missing++;
        return;
      }
      row.cutM3 += r.cutM3;
      row.fillM3 += r.fillM3;
      row.netM3 += r.netM3;
      row.totalM3 += r.totalM3;
      row.areaM2 += r.areaM2;
      row.counted++;
    });
  }
  return { template, mixed, measurements: selected.length, rows, areaM2 };
}

/** Which side of an item a bulk change sets. */
export type BulkSide = 'from' | 'to';

/**
 * Set one side of item `index` on every measurement to `ref` (a surface: bases keep each polygon's
 * own parameters, so a base is only set where that side is a base of the same kind already or the
 * caller gives one built for each polygon). The results of changed items are marked stale.
 */
export function setSideForAll(
  measurements: readonly SurveyMeasurement[],
  index: number,
  side: BulkSide,
  ref: SurfaceRef | ((m: SurveyMeasurement) => SurfaceRef),
): SurveyMeasurement[] {
  return measurements.map((m) => {
    const it = m.items[index];
    if (!it) return m;
    const next = typeof ref === 'function' ? ref(m) : ref;
    const other = side === 'from' ? it.to : it.from;
    if (isBase(next) && isBase(other)) return m;
    if (sideKey(it[side]) === sideKey(next) && JSON.stringify(it[side]) === JSON.stringify(next))
      return m;
    const items = m.items.map((x, k) => (k === index ? { ...x, [side]: next } : x));
    return {
      ...m,
      items,
      results: m.results.map((r) => (r.item === it.id ? { ...r, status: 'stale' as const } : r)),
    };
  });
}

/** Give every measurement the same units override (an empty override means the site units). */
export function setUnitsForAll(
  measurements: readonly SurveyMeasurement[],
  units: UnitsOverride,
): SurveyMeasurement[] {
  const clean = Object.fromEntries(
    Object.entries(units).filter(([, v]) => v !== undefined),
  ) as UnitsOverride;
  return measurements.map((m) => {
    const next: SurveyMeasurement = { ...m };
    if (Object.keys(clean).length > 0) next.units = { ...clean };
    else delete next.units;
    return next;
  });
}

// ---------------------------------------------------------------- site inventory over time (W4)

/** A per-date row's date (R16, `seriesDate`), undefined without one. */
const rowDate = (r: ComparisonResult): string | undefined => seriesDate(r) || undefined;

/**
 * One item's figures per date, the one rule the volume card and the inventory share: its per-date
 * series, with its stored result standing for its own date (stale or not), so one item has one
 * figure per date. A figure carried over from an earlier version counts as the item's figure for
 * its own dates (R16). An item fixed to its dates (no current side) has its stored figure only. `stored` is that stored row (to mark it stale with the stored figures).
 * The item is the first comparison unless named.
 */
export function pileSeries(
  m: Pick<SurveyMeasurement, 'items' | 'results' | 'series'>,
  item: string | undefined = m.items[0]?.id,
): { series: ComparisonResult[]; stored: ComparisonResult | undefined } {
  if (item === undefined) return { series: [], stored: undefined };
  const keyed = (r: ComparisonResult) => {
    const d = rowDate(r);
    return d !== undefined && r.toCapture === undefined ? { ...r, toCapture: d } : r;
  };
  // an item with no current side has no volume over time (R16, `seriesApplies`): rows worked out
  // before it was fixed to its dates are left out, a figure carried from the kit stays
  const it = m.items.find((x) => x.id === item);
  const fixed = it !== undefined && it.from.kind !== 'current' && it.to.kind !== 'current';
  const series = (m.series ?? [])
    .filter((r) => r.item === item && (!fixed || r.carried !== undefined))
    .map(keyed);
  const found = m.results.find((r) => r.item === item);
  const date = found ? rowDate(found) : undefined;
  if (!found || date === undefined) return { series, stored: undefined };
  const stored = keyed(found);
  return { series: [...series.filter((r) => r.toCapture !== date), stored], stored };
}

/**
 * The volume measurements an inventory covers: all of them, or those in one folder. One without
 * a comparison is still a pile (listed, and named as not counted).
 */
export function inventoryPiles(
  ms: readonly SurveyMeasurement[],
  folder?: string | null,
): SurveyMeasurement[] {
  const want = folder?.trim() ?? '';
  return ms.filter(
    (m) =>
      m.tool === 'volume' && m.family === 'polygon' && (want === '' || m.folder?.trim() === want),
  );
}

export interface InventoryOptions {
  /** Narrow to one folder (leave out when `ms` is already the folder's piles). */
  folder?: string | null;
  quantity?: 'net' | 'total';
  /**
   * Whether a figure is not current: `stored` is true for the measurement's stored result (the app
   * checks it against the current fingerprints), false for a per-date row. Without it only a
   * figure marked stale is.
   */
  isStale?: (m: SurveyMeasurement, r: ComparisonResult, stored: boolean) => boolean;
  /** Why working out a measurement's dates failed, if it did. */
  failed?: (m: SurveyMeasurement) => string | null | undefined;
  /**
   * Whether a measurement's dates were worked out for a capture: a date that was, yet has no
   * figure, has no survey data (not "not computed yet").
   */
  ran?: (m: SurveyMeasurement, capture: string) => boolean;
}

/**
 * The site inventory over time (W4), one row per survey date: the volume measurements given (or
 * those in `opts.folder`) stacked. A total adds current figures only. A stale figure, a refused or
 * missing one, a failed run or a measurement without a comparison is named in `notCounted` with
 * why, never added (and never as zero); `missing` keeps the ones without survey data. A figure
 * partly outside the survey is added and named in `partial`. A carried figure counts for its own
 * dates (R16). The change is worked out over the piles counted on both dates.
 */
export function inventorySeries(
  ms: readonly SurveyMeasurement[],
  captures: readonly { id: string; date: string; label: string }[],
  opts: InventoryOptions = {},
): StackRow[] {
  const piles = inventoryPiles(ms, opts.folder);
  if (piles.length === 0) return [];
  const sorted = [...captures].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1,
  );
  const out: StackRow[] = sorted.map((c) => ({
    capture: c.id,
    date: c.date,
    label: c.label,
    totalM3: 0,
    parts: [],
    missing: [],
    notCounted: [],
    partial: [],
    cutM3: 0,
    fillM3: 0,
    change: null,
  }));
  const at = new Map(out.map((s) => [s.capture, s]));
  // the kit's last date: the latest date any carried figure is on. A carried pile without a
  // figure on a later date needs a recompute there; on an earlier one it was absent (R16).
  let kitLast = '';
  for (const m of piles)
    for (const r of pileSeries(m).series) {
      const d = r.carried !== undefined ? at.get(r.toCapture ?? '')?.date : undefined;
      if (d !== undefined && d > kitLast) kitLast = d;
    }
  for (const m of piles) {
    if (m.items.length === 0) {
      for (const s of out) s.notCounted?.push({ id: m.id, reason: 'no-comparison' });
      continue;
    }
    const { series, stored } = pileSeries(m);
    const carried = series.some((r) => r.carried !== undefined);
    const failed = opts.failed?.(m) ?? null;
    const rows: TimeRow[] = volumeRows(series, sorted, {
      isStale: (r) => r.status === 'stale' || (opts.isStale?.(m, r, r === stored) ?? false),
      ...(opts.quantity !== undefined ? { quantity: opts.quantity } : {}),
    });
    for (const row of rows) {
      const s = at.get(row.capture);
      if (!s) continue;
      if (row.valueM3 === null) {
        // refused there, absent on a kit date a carried pile has no figure for (R16), or worked
        // out with nothing to show; else the last run failed, or it has not run for this date yet
        // (a carried pile on a date after the kit's last one too)
        const noData =
          row.status === 'refused' ||
          (carried && row.date <= kitLast) ||
          (failed === null && opts.ran?.(m, row.capture) === true);
        if (noData) {
          s.missing.push(m.id);
          s.notCounted?.push({ id: m.id, reason: 'no-data' });
        } else if (failed !== null)
          s.notCounted?.push({ id: m.id, reason: 'failed', detail: failed });
        else s.notCounted?.push({ id: m.id, reason: 'not-computed' });
        continue;
      }
      if (row.stale) {
        s.notCounted?.push({ id: m.id, reason: 'stale' });
        continue;
      }
      const r = series.find((x) => x.toCapture === row.capture);
      s.parts.push({ id: m.id, valueM3: row.valueM3 });
      s.totalM3 += row.valueM3;
      s.cutM3 = (s.cutM3 ?? 0) + (r?.cutM3 ?? 0);
      s.fillM3 = (s.fillM3 ?? 0) + (r?.fillM3 ?? 0);
      if (row.status === 'partial') s.partial?.push(m.id);
    }
  }
  // the change since the nearest earlier date with counted piles, over the piles on both
  let prev: StackRow | undefined;
  for (const s of out) {
    if (s.parts.length === 0) continue;
    if (prev) {
      const before = new Map(prev.parts.map((p) => [p.id, p.valueM3]));
      const common = s.parts.filter((p) => before.has(p.id));
      const of = new Set([...s.parts.map((p) => p.id), ...before.keys()]).size;
      s.change =
        common.length === 0
          ? null
          : {
              m3: common.reduce((sum, p) => sum + p.valueM3 - (before.get(p.id) ?? 0), 0),
              piles: common.length,
              of,
            };
    }
    prev = s;
  }
  return out;
}
