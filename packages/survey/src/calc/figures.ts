import type { ComparisonResult, SiteMaterial, SurveyMeasurement } from '@aio/schema';
import { pileSeries } from './bulk';
import { densityOn, materialColour, type CaptureDateOf } from './materials';

/**
 * A pile's figure on a survey date (volumetrics redesign, Stage C). Rows, scene labels, cards,
 * the pile panel and the totals read the date in focus through here, never `results[0]` alone:
 * a converted kit pile's stored result is only its last date's figure.
 */

export type PileFigureStatus = 'ok' | 'partial' | 'stale' | 'refused' | 'carried';

export interface PileFigure {
  capture: string;
  netM3: number;
  cutM3: number;
  fillM3: number;
  /** A figure never shows without it: refused and stale first, then carried, then partial. */
  status: PileFigureStatus;
}

/** What a figure is read from (a measurement, or the readout's geometry with its results). */
export type FigureSource = Partial<Pick<SurveyMeasurement, 'items' | 'results' | 'series'>>;

/**
 * The full result row of a pile's first comparison on a capture: the stored result when it is
 * that capture's, else the per-date `series` row for it, else null (`pileSeries`' one rule).
 */
export function resultOn(m: FigureSource, capture: string): ComparisonResult | null {
  const items = m.items ?? [];
  if (items.length === 0) return null;
  const { series } = pileSeries({
    items,
    results: m.results ?? [],
    ...(m.series !== undefined ? { series: m.series } : {}),
  });
  return series.find((r) => r.toCapture === capture) ?? null;
}

/** A result's status as a figure shows it. */
export function figureStatus(r: ComparisonResult): PileFigureStatus {
  if (r.status === 'refused' || r.status === 'stale') return r.status;
  if (r.carried !== undefined) return 'carried';
  return r.status;
}

/** A pile's figure on a capture (see `resultOn`), or null when it has none for that date. */
export function figureOn(m: FigureSource, capture: string): PileFigure | null {
  const r = resultOn(m, capture);
  if (!r) return null;
  return {
    capture,
    netM3: r.netM3,
    cutM3: r.cutM3,
    fillM3: r.fillM3,
    status: figureStatus(r),
  };
}

/** A figure that is added to totals: stale and refused ones never are. */
const counted = (f: PileFigure | null): f is PileFigure =>
  f !== null && f.status !== 'stale' && f.status !== 'refused';

export interface MaterialGroupPile {
  id: string;
  label: string;
  volumeM3: number;
  tonnes: number | null;
  /** The change since the previous date; null without a counted figure there. */
  deltaM3: number | null;
}

export interface MaterialGroup {
  /** null for "No material" (no material, or one the site no longer has). */
  material: SiteMaterial | null;
  colour: string;
  volumeM3: number;
  /** null without a density (and always for "No material"). */
  tonnes: number | null;
  /** The sum of the piles' changes that have one; null when none has. */
  deltaM3: number | null;
  piles: MaterialGroupPile[];
}

/** The colour "No material" takes (a design token the renderer defines). */
export const NO_MATERIAL_COLOUR = 'var(--mat-none)';

/**
 * The inventory on a capture grouped by material: each group with its colour, net volume, tonnes
 * at the material's density on that date (`densityOn`) and change since `previous`. Only counted
 * figures are added (stale, refused and absent ones are left out, never as zero). Groups are
 * sorted by volume, largest first, with "No material" last; piles by volume, largest first.
 *
 * `materialOf` says which material a pile weighs by (default: its site material). A converted
 * kit pile with none weighs by the kit's site-wide density (`pileMaterial`), a material that is
 * not among the site's: it is grouped by its name and coloured after the site's materials.
 */
export function inventoryByMaterial(
  piles: readonly SurveyMeasurement[],
  capture: string,
  previous: string | null,
  materials: readonly SiteMaterial[],
  dateOf: CaptureDateOf,
  materialOf?: (m: SurveyMeasurement) => SiteMaterial | null,
): MaterialGroup[] {
  const index = new Map(materials.map((m, i) => [m.id, i]));
  const groups = new Map<string | null, MaterialGroup>();
  const own = (m: SurveyMeasurement): SiteMaterial | null => {
    const at = m.material !== undefined ? index.get(m.material) : undefined;
    return at !== undefined ? (materials[at] ?? null) : null;
  };
  /** Materials outside the site's list, by name, in the order met (their colour slot). */
  const others = new Map<string, number>();
  for (const m of piles) {
    const f = figureOn(m, capture);
    if (!counted(f)) continue;
    const material = materialOf ? materialOf(m) : own(m);
    const site = material ? index.get(material.id) : undefined;
    const isSite = site !== undefined && materials[site]?.name === material?.name;
    let slot = site;
    if (material && !isSite) {
      slot = others.get(material.name) ?? materials.length + others.size;
      others.set(material.name, slot);
    }
    const key = material ? (isSite ? material.id : `\u0000${material.id}:${material.name}`) : null;
    let g = groups.get(key);
    if (!g) {
      g = {
        material,
        colour:
          material && slot !== undefined ? materialColour(material, slot) : NO_MATERIAL_COLOUR,
        volumeM3: 0,
        tonnes: null,
        deltaM3: null,
        piles: [],
      };
      groups.set(key, g);
    }
    const density = material ? densityOn(material, capture, dateOf) : null;
    const tonnes = density === null ? null : f.netM3 * density;
    const before = previous !== null ? figureOn(m, previous) : null;
    const deltaM3 = counted(before) ? f.netM3 - before.netM3 : null;
    g.piles.push({ id: m.id, label: m.label, volumeM3: f.netM3, tonnes, deltaM3 });
    g.volumeM3 += f.netM3;
    if (tonnes !== null) g.tonnes = (g.tonnes ?? 0) + tonnes;
    if (deltaM3 !== null) g.deltaM3 = (g.deltaM3 ?? 0) + deltaM3;
  }
  const out = [...groups.values()];
  for (const g of out) g.piles.sort((a, b) => b.volumeM3 - a.volumeM3);
  return out.sort((a, b) =>
    a.material === null ? 1 : b.material === null ? -1 : b.volumeM3 - a.volumeM3,
  );
}

/**
 * The rows a "by pile" chart draws: the `keep` rows with the largest change, sorted by net (most
 * cut first), and the rest folded with how many and the largest |net| among them, rounded up to a
 * whole cubic metre ("+ 6 piles within ±35 m³").
 */
export function foldSmall<T extends { netM3: number }>(
  rows: readonly T[],
  keep = 13,
): { shown: T[]; folded: { count: number; withinM3: number } | null } {
  const byNet = (a: T, b: T) => a.netM3 - b.netM3;
  if (rows.length <= keep) return { shown: [...rows].sort(byNet), folded: null };
  const bySize = [...rows].sort((a, b) => Math.abs(b.netM3) - Math.abs(a.netM3));
  const shown = bySize.slice(0, Math.max(0, keep)).sort(byNet);
  const rest = bySize.slice(Math.max(0, keep));
  const largest = rest.reduce((mx, r) => Math.max(mx, Math.abs(r.netM3)), 0);
  return { shown, folded: { count: rest.length, withinM3: Math.ceil(largest) } };
}
