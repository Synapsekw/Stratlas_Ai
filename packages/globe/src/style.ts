import type { GlobeSettings } from '@aio/schema';

/**
 * How the Globe looks (founder, 10 Oct 2026). `street`: the app's dark street map on the Earth,
 * from the installed street packs, over the bundled land and border shapes; the default.
 * `satellite`: the installed imagery packs over that street globe, an explicit choice.
 * `natural-earth`: the painted Natural Earth II raster of the first Globe, with imagery packs.
 */
export const GLOBE_STYLES = ['street', 'satellite', 'natural-earth'] as const;
export type GlobeStyle = (typeof GLOBE_STYLES)[number];
export const DEFAULT_GLOBE_STYLE: GlobeStyle = 'street';

/** The style a saved `globe.json` asks for; the street map when it names none (or one unknown). */
export function globeStyleOf(
  settings: Pick<GlobeSettings, 'style'> | null | undefined,
): GlobeStyle {
  const named = settings?.style;
  return GLOBE_STYLES.find((style) => style === named) ?? DEFAULT_GLOBE_STYLE;
}

/**
 * The colours the Globe draws with. Water, land and borders are those of the street style
 * (`@aio/maps` `STREET`), so the bundled land shapes and a street pack meet without a seam; the
 * rest are the dark Mission tokens. The app passes the street style's own values; these are the
 * same numbers for when nothing is passed (a test in the app keeps the two equal).
 */
export interface GlobePalette {
  /** Behind the Earth: the deepest Mission surface. */
  space: string;
  water: string;
  land: string;
  border: string;
  /** Sites without open issues, selections, the rim of the atmosphere (the mint accent). */
  accent: string;
  accentStrong: string;
  /** Sites with open issues. */
  attention: string;
  /** Light ink on the dark Earth: pin cores, cluster counts. */
  ink: string;
}

export const STREET_GLOBE_PALETTE: GlobePalette = {
  space: '#080a0d',
  water: '#01141f',
  land: '#101317',
  border: '#4d5660',
  accent: '#60d3b2',
  accentStrong: '#73ebc8',
  attention: '#f48d3c',
  ink: '#eaedf1',
};

/** `#rrggbb` as red, green and blue in 0..1 (for the scene's own colours). */
export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  return [
    parseInt(m[1] ?? '0', 16) / 255,
    parseInt(m[2] ?? '0', 16) / 255,
    parseInt(m[3] ?? '0', 16) / 255,
  ];
}

/** `#rrggbb` with an opacity, as a CSS colour for the 2D canvases the pins are drawn on. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexRgb(hex);
  const c = (v: number) => String(Math.round(v * 255));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${String(Math.max(0, Math.min(1, alpha)))})`;
}
