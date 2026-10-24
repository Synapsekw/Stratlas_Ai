/**
 * The Volumes tab's figures on the date in focus (volumetrics redesign, spec section 6, board 1):
 * the header's Volume, Tonnes and change since the previous survey, and the Inventory table's
 * groups by material with their subtotals. Pure.
 *
 * One rule for what is counted: the site inventory's row for the date (`useInventory`, the app's
 * stale and failure checks). A pile it leaves out is left out of every figure here too, and the
 * change is over the piles counted on both this date and the nearest earlier date with counted
 * piles, so the header, the subtotals and the site total always agree.
 */
import type { SiteMaterial, SurveyMeasurement } from '@aio/schema';
import {
  densityOn,
  figureOn,
  inventoryByMaterial,
  type CaptureDateOf,
  type FigureSource,
  type MaterialGroup,
  type NotCounted,
  type PileFigure,
  type StackRow,
} from '@aio/survey';

// ---------------------------------------------------------------- the one counting rule

/**
 * Whether pile `pile`'s figure on `capture` is added to totals: the site inventory's rule
 * (`useInventory`: stale by the fingerprints or the series check, refused, failed and missing
 * figures are left out). Every total, list and change reads this, never a figure's status alone.
 */
export type IsCounted = (pile: string, capture: string) => boolean;

/** The counting rule as a lookup, from the site inventory's rows (`useInventory`, `useCounted`). */
export function countedBy(rows: readonly StackRow[]): IsCounted {
  const on = new Map(rows.map((r) => [r.capture, new Set(r.parts.map((p) => p.id))]));
  return (pile, capture) => on.get(capture)?.has(pile) ?? false;
}

/** A pile's figure on a capture when the rule counts it, else null. */
export function countedFigureOn(
  m: FigureSource & { id: string },
  capture: string,
  isCounted: IsCounted,
): PileFigure | null {
  return isCounted(m.id, capture) ? figureOn(m, capture) : null;
}

/**
 * The inventory by material on `capture` by the rule: only counted piles, each pile's change over
 * `previous` only when it is counted there too (null otherwise), the groups' changes summed from
 * those. `previous` is the nearest earlier date with counted piles (the caller finds it).
 */
export function countedGroups(
  piles: readonly SurveyMeasurement[],
  capture: string,
  previous: string | null,
  materials: readonly SiteMaterial[],
  dateOf: CaptureDateOf,
  isCounted: IsCounted,
): MaterialGroup[] {
  const here = piles.filter((m) => isCounted(m.id, capture));
  const byId = new Map(here.map((m) => [m.id, m]));
  return inventoryByMaterial(here, capture, previous, materials, dateOf).map((g) => {
    const ps = g.piles.map((p) => {
      const m = byId.get(p.id);
      const was = m && previous !== null ? countedFigureOn(m, previous, isCounted) : null;
      return { ...p, deltaM3: was ? p.volumeM3 - was.netM3 : null };
    });
    const deltas = ps.flatMap((p) => (p.deltaM3 === null ? [] : [p.deltaM3]));
    return {
      ...g,
      piles: ps,
      deltaM3: deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) : null,
    };
  });
}

/** A survey date as the header names it. */
export interface InventoryDate {
  capture: string;
  date: string;
  label: string;
}

/** A material's group with its density on the date (null without one, and for "No material"). */
export interface InventoryGroup extends MaterialGroup {
  densityTPerM3: number | null;
}

export interface InventoryModel {
  /** The date the figures are for. */
  on: InventoryDate;
  /** The nearest earlier date with counted piles; null on the first. */
  previous: InventoryDate | null;
  volumeM3: number;
  /** The counted piles. */
  piles: number;
  /** Null when no counted pile has a density. */
  tonnes: number | null;
  /** Every counted pile has a density, so `tonnes` is the whole site's. */
  tonnesComplete: boolean;
  /** Over the piles counted on both dates; null without a previous date or a pile on both. */
  change: { m3: number; pct: number | null } | null;
  groups: InventoryGroup[];
  /** Piles left out of the figures, with why (the inventory row's). */
  notCounted: readonly NotCounted[];
  /** Counted piles whose figure is partly outside the survey. */
  partial: readonly string[];
}

const dateOfRow = (r: StackRow): InventoryDate => ({
  capture: r.capture,
  date: r.date,
  label: r.label,
});

/**
 * The figures on `capture` (the date in focus; the latest date when it has no row), or null when
 * the project has no survey date.
 */
export function inventoryModel(
  piles: readonly SurveyMeasurement[],
  rows: readonly StackRow[],
  capture: string | null,
  materials: readonly SiteMaterial[],
  dateOf: CaptureDateOf,
): InventoryModel | null {
  let at = rows.findIndex((r) => r.capture === capture);
  if (at < 0) at = rows.length - 1;
  const row = rows[at];
  if (!row) return null;
  let prev: StackRow | undefined;
  for (let i = at - 1; i >= 0; i--) {
    const r = rows[i];
    if (r && r.parts.length > 0) {
      prev = r;
      break;
    }
  }
  const counted = new Set(row.parts.map((p) => p.id));
  const before = new Map((prev?.parts ?? []).map((p) => [p.id, p.valueM3]));

  const groups: InventoryGroup[] = inventoryByMaterial(
    piles.filter((m) => counted.has(m.id)),
    row.capture,
    prev?.capture ?? null,
    materials,
    dateOf,
  ).map((g) => {
    // the change by the inventory's rule: counted on both dates
    const ps = g.piles.map((p) => {
      const was = before.get(p.id);
      return { ...p, deltaM3: was === undefined ? null : p.volumeM3 - was };
    });
    const deltas = ps.flatMap((p) => (p.deltaM3 === null ? [] : [p.deltaM3]));
    return {
      ...g,
      piles: ps,
      deltaM3: deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) : null,
      densityTPerM3: g.material ? densityOn(g.material, row.capture, dateOf) : null,
    };
  });

  const all = groups.flatMap((g) => g.piles);
  const volumeM3 = all.reduce((a, p) => a + p.volumeM3, 0);
  const withTonnes = all.filter((p) => p.tonnes !== null);
  const tonnes = withTonnes.length > 0 ? withTonnes.reduce((a, p) => a + (p.tonnes ?? 0), 0) : null;
  const both = all.filter((p) => p.deltaM3 !== null);
  let change: InventoryModel['change'] = null;
  if (both.length > 0) {
    const m3 = both.reduce((a, p) => a + (p.deltaM3 ?? 0), 0);
    const base = both.reduce((a, p) => a + (before.get(p.id) ?? 0), 0);
    change = { m3, pct: base > 0 ? (m3 / base) * 100 : null };
  }
  return {
    on: dateOfRow(row),
    previous: prev ? dateOfRow(prev) : null,
    volumeM3,
    piles: all.length,
    tonnes,
    tonnesComplete: all.length > 0 && withTonnes.length === all.length,
    change,
    groups,
    notCounted: row.notCounted ?? [],
    partial: row.partial ?? [],
  };
}

/** How many piles a material shows before "+ n more". */
export const GROUP_SHOWN = 4;
