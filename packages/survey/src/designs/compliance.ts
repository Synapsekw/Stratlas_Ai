import type { ComparisonItem, HeatmapStyle } from '@aio/schema';

/**
 * Compliance to design (M11 G6, DSN-3): the tolerance heat map, the in-tolerance share of an area
 * and the two comparison presets the comparison UI (G4) offers for a design surface.
 *
 * Sign convention of section 26: `dz = To - From`. Both presets compare **from** the current survey
 * **to** the design, so `dz > 0` is fill still needed (the ground is below the design) and `dz < 0`
 * cut still needed (above the design). A cell is in tolerance when `|dz| <= toleranceM`.
 */

export const COMPLIANCE_COLOURS = {
  cut: '#b2182b',
  inTolerance: '#9e9e9e',
  fill: '#2166ac',
} as const;

/**
 * Heat map stops for plus and minus a tolerance (a stepped map: each stop colours values from it up
 * to the next stop, and values below the first stop take the first colour): cut beyond the
 * tolerance red, in tolerance grey, fill beyond it blue.
 */
export function toleranceHeatmap(toleranceM: number): HeatmapStyle {
  if (!(toleranceM > 0) || !Number.isFinite(toleranceM))
    throw new RangeError('A tolerance is a positive number of metres.');
  return {
    stops: [
      { value: -2 * toleranceM, color: COMPLIANCE_COLOURS.cut },
      { value: -toleranceM, color: COMPLIANCE_COLOURS.inTolerance },
      { value: toleranceM, color: COMPLIANCE_COLOURS.fill },
    ],
    stepped: true,
  };
}

export type ToleranceBand = 'cut' | 'in' | 'fill';

/** The band of one cell's `dz`; null for nodata. */
export function toleranceBand(dz: number, toleranceM: number): ToleranceBand | null {
  if (!Number.isFinite(dz)) return null;
  if (dz < -toleranceM) return 'cut';
  if (dz > toleranceM) return 'fill';
  return 'in';
}

export interface ToleranceShare {
  /** Covered area (cells with a dz), square metres. */
  areaM2: number;
  inToleranceM2: number;
  /** Above the design beyond the tolerance (cut still to do). */
  cutM2: number;
  /** Below the design beyond the tolerance (fill still to do). */
  fillM2: number;
  /** Area with no dz (holes), square metres; never counted as in tolerance. */
  uncoveredM2: number;
  /** In-tolerance area over covered area, 0 to 1 (0 when nothing is covered). */
  share: number;
}

/**
 * The in-tolerance share of an area from a grid of `dz` (NaN for nodata), each cell `cellAreaM2`
 * times its coverage weight (1 when absent: partial cells at a polygon edge carry their share).
 */
export function toleranceShare(
  dz: ArrayLike<number>,
  toleranceM: number,
  cellAreaM2: number,
  coverage?: ArrayLike<number>,
): ToleranceShare {
  if (!(toleranceM >= 0)) throw new RangeError('A tolerance is zero or more metres.');
  if (coverage && coverage.length !== dz.length)
    throw new RangeError('The coverage grid and the dz grid differ in size.');
  let inside = 0;
  let cut = 0;
  let fill = 0;
  let uncovered = 0;
  for (let i = 0; i < dz.length; i++) {
    const a = cellAreaM2 * (coverage ? (coverage[i] ?? 0) : 1);
    if (a <= 0) continue;
    const band = toleranceBand(dz[i] ?? Number.NaN, toleranceM);
    if (band === null) uncovered += a;
    else if (band === 'in') inside += a;
    else if (band === 'cut') cut += a;
    else fill += a;
  }
  const area = inside + cut + fill;
  return {
    areaM2: area,
    inToleranceM2: inside,
    cutM2: cut,
    fillM2: fill,
    uncoveredM2: uncovered,
    share: area > 0 ? inside / area : 0,
  };
}

export type DesignPreset = 'cut-fill-to-design' | 'remaining-to-design';

export const DESIGN_PRESET_LABELS: Record<DesignPreset, string> = {
  'cut-fill-to-design': 'Cut/Fill to design',
  'remaining-to-design': 'Remaining to design',
};

/**
 * A comparison item for a design surface layer. **Cut/Fill to design** counts every cell;
 * **Remaining to design** leaves out the cells within the tolerance (the deadband), so what it
 * reports is the volume still to move.
 */
export function designComparisonItem(
  preset: DesignPreset,
  opts: { id: string; design: string; layer: string; toleranceM: number },
): ComparisonItem {
  const base = {
    id: opts.id,
    label: DESIGN_PRESET_LABELS[preset],
    from: { kind: 'current' as const },
    to: { kind: 'design' as const, design: opts.design, layer: opts.layer },
  };
  return preset === 'remaining-to-design'
    ? { ...base, deadbandM: opts.toleranceM, useDeadband: true }
    : { ...base, useDeadband: false };
}
