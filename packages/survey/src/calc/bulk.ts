import type {
  ComparisonItem,
  ComparisonResult,
  SurfaceRef,
  SurveyMeasurement,
  UnitsOverride,
} from '@aio/schema';
import { isBase, sideKey } from './pickers';
import { stackRows, volumeRows, type StackRow, type TimeRow } from './timeline';

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

/** A per-date row's date (R16): the `to` capture, else the `from` one. */
const rowDate = (r: ComparisonResult): string | undefined => r.toCapture ?? r.fromCapture;

/**
 * A pile's figures per date for its first comparison: its per-date series, with its stored result
 * standing for its own date (stale or not), so one pile has one figure per date. A figure carried
 * over from an earlier version counts as the pile's figure for its own dates (R16).
 */
export function pileSeries(m: SurveyMeasurement): ComparisonResult[] {
  const item = m.items[0];
  if (!item) return [];
  const keyed = (r: ComparisonResult) => {
    const d = rowDate(r);
    return d !== undefined && r.toCapture === undefined ? { ...r, toCapture: d } : r;
  };
  const series = (m.series ?? []).filter((r) => r.item === item.id).map(keyed);
  const stored = m.results.find((r) => r.item === item.id);
  const date = stored ? rowDate(stored) : undefined;
  if (!stored || date === undefined) return series;
  return [...series.filter((r) => r.toCapture !== date), keyed(stored)];
}

/** The volume measurements an inventory covers: all of them, or those in one folder. */
export function inventoryPiles(
  ms: readonly SurveyMeasurement[],
  folder?: string | null,
): SurveyMeasurement[] {
  const want = folder?.trim() ?? '';
  return ms.filter(
    (m) =>
      m.tool === 'volume' &&
      m.family === 'polygon' &&
      m.items.length > 0 &&
      (want === '' || m.folder?.trim() === want),
  );
}

/**
 * The site inventory over time (W4): the volume measurements in `opts.folder` (or all of them)
 * stacked per survey date. Only the engine's stored results and per-date series are added, and a
 * carried figure counts for its own dates (R16). A pile without a figure on a date (refused there,
 * never computed, or absent) is named in that date's `missing`, never added as zero.
 */
export function inventorySeries(
  ms: readonly SurveyMeasurement[],
  captures: readonly { id: string; date: string; label: string }[],
  opts: {
    folder?: string | null;
    quantity?: 'net' | 'total';
    isStale?: (m: SurveyMeasurement, r: ComparisonResult) => boolean;
  } = {},
): StackRow[] {
  const rows = new Map<string, readonly TimeRow[]>();
  for (const m of inventoryPiles(ms, opts.folder))
    rows.set(
      m.id,
      volumeRows(pileSeries(m), captures, {
        isStale: (r) => opts.isStale?.(m, r) ?? false,
        ...(opts.quantity !== undefined ? { quantity: opts.quantity } : {}),
      }),
    );
  return stackRows(rows);
}
