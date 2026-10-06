import type { Layer } from '@aio/schema';

/**
 * The fixed look of change results (M8 C2): the colour legend of a change heat map and the style
 * of change polygons. The pipelines (`change.raster`, `change.surface`) bake the same colours into
 * the heat map tiles and write the legend they used into its `tiles.json` (`legend`); the app
 * reads that legend, and falls back to the defaults here for an index without one.
 */

/** A legend: colour stops along a value (a 0 to 1 score, or metres of height change). */
export interface ChangeLegend {
  kind: 'score' | 'metres';
  /** Unit after the numbers ('m'), empty for a score. */
  unit: string;
  label: string;
  /** Ascending `[value, #rrggbb]`. */
  stops: [number, string][];
}

/** Imagery change: yellow to red as the change score rises (`change/raster.py` SCORE_STOPS). */
export const SCORE_LEGEND: ChangeLegend = {
  kind: 'score',
  unit: '',
  label: 'Change score',
  stops: [
    [0.35, '#ffd34d'],
    [0.6, '#ff8a00'],
    [1, '#e8202a'],
  ],
};

/** Surface change: blue is lower (cut), red is higher (fill) (`change/surface.py` SURFACE_STOPS). */
export const METRES_LEGEND: ChangeLegend = {
  kind: 'metres',
  unit: 'm',
  label: 'Height change',
  stops: [
    [-2, '#2166ac'],
    [-0.5, '#67a9cf'],
    [-0.1, '#d1e5f0'],
    [0.1, '#fddbc7'],
    [0.5, '#ef8a62'],
    [2, '#b2182b'],
  ],
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The legend in a heat map's `tiles.json`, checked; null when absent or malformed. */
export function parseChangeLegend(tiles: unknown): ChangeLegend | null {
  const l = (tiles as { legend?: unknown } | null)?.legend as Partial<ChangeLegend> | undefined;
  if (!l || typeof l !== 'object') return null;
  if (l.kind !== 'score' && l.kind !== 'metres') return null;
  if (!Array.isArray(l.stops) || l.stops.length < 2) return null;
  const stops: [number, string][] = [];
  for (const s of l.stops as unknown[]) {
    if (
      !Array.isArray(s) ||
      typeof s[0] !== 'number' ||
      typeof s[1] !== 'string' ||
      !HEX.test(s[1])
    )
      return null;
    if (stops.length && s[0] <= (stops.at(-1)?.[0] ?? -Infinity)) return null;
    stops.push([s[0], s[1]]);
  }
  return {
    kind: l.kind,
    unit: typeof l.unit === 'string' ? l.unit : l.kind === 'metres' ? 'm' : '',
    label: typeof l.label === 'string' && l.label ? l.label : defaultLegend(l.kind).label,
    stops,
  };
}

export function defaultLegend(kind: ChangeLegend['kind']): ChangeLegend {
  return kind === 'metres' ? METRES_LEGEND : SCORE_LEGEND;
}

/** A CSS linear gradient (left to right) of the stops, spaced by value. */
export function legendGradient(legend: ChangeLegend): string {
  const first = legend.stops[0]?.[0] ?? 0;
  const last = legend.stops.at(-1)?.[0] ?? 1;
  const span = last - first || 1;
  const parts = legend.stops.map(
    ([v, c]) => `${c} ${String(Math.round(((v - first) / span) * 1000) / 10)}%`,
  );
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** A legend number: signed metres ("+0.5 m", "-2 m"), or a score as a percentage. */
export function legendValue(legend: ChangeLegend, v: number): string {
  if (legend.kind === 'score') return `${String(Math.round(v * 100))}%`;
  const n = Math.abs(v) < 1 ? String(Math.round(v * 100) / 100) : String(Math.round(v * 10) / 10);
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${n.replace('-', '')} ${legend.unit}`.trim();
}

/** The ends and the middle stop of a legend, for its labels. */
export function legendTicks(legend: ChangeLegend): { value: number; text: string }[] {
  const s = legend.stops;
  const picks =
    s.length > 2 ? [s[0], s[Math.floor((s.length - 1) / 2)], s.at(-1)] : [s[0], s.at(-1)];
  const out: { value: number; text: string }[] = [];
  for (const p of picks) if (p) out.push({ value: p[0], text: legendValue(legend, p[0]) });
  // metres: the middle tick reads as the band around zero
  if (legend.kind === 'metres' && out.length === 3) out[1] = { value: 0, text: `0 ${legend.unit}` };
  return out;
}

type RasterLayer = Extract<Layer, { kind: 'raster' }>;

/** A raster layer a change pipeline wrote as a heat map (derived, kit pyramid). */
export function isChangeHeatMap(layer: Layer): layer is RasterLayer {
  return (
    layer.kind === 'raster' && layer.derived?.kind === 'change' && layer.format === 'kit-pyramid'
  );
}

/** Region polygons of a change run (`change.raster`): one colour. */
export const RASTER_REGION_STYLE = {
  line: { color: '#e8202a', width: 2 },
  fill: { color: '#e8202a', opacity: 0.12 },
} as const;

/** Region polygons of `change.surface`: blue cut, red fill, by the `sign` property. */
export const SURFACE_REGION_STYLE = {
  line: { color: '#e8eaee', width: 1.5 },
  fill: { color: '#b2182b', opacity: 0.15 },
  colorBy: {
    field: 'sign',
    stops: [
      [-1, '#2166ac'],
      [1, '#b2182b'],
    ] as [number, string][],
  },
} as const;
