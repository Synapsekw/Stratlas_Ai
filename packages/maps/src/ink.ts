// The street maps are always dark (founder decision 2026-10-05): one palette for every map the app
// draws, whatever the app theme. Colours come from the Mission tokens (packages/ui/src/tokens.css,
// dark) as oklch and are converted here, because MapLibre does not parse oklch.

/** sRGB hex of an oklch colour (lightness 0..1, chroma, hue in degrees), clipped to the gamut. */
export function oklchHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
  return `#${linear
    .map((x) => {
      const v = Math.min(1, Math.max(0, x));
      const srgb = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      return Math.round(srgb * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

/** A Mission neutral (hue 250, the tokens' blue-grey) at a lightness. */
const grey = (l: number, c = 0.011) => oklchHex(l, c, 250);

/**
 * Ink for overlays drawn on the dark street map (issues, flights, footprints, picks, coverage):
 * the dark Mission tokens, used in every theme because the map under them is always dark.
 */
export const MAP_INK = {
  /** --bg-0: the deepest surface, also halos and marker outlines. */
  bg0: grey(0.145, 0.008),
  /** --fg-0: text and outlines that must stand out. */
  fg0: grey(0.945, 0.006),
  /** --fg-1. */
  fg1: grey(0.8, 0.01),
  /** --fg-2: secondary lines (inactive flight paths). */
  fg2: grey(0.64, 0.012),
  /** --line-strong: hairlines that should stay quiet. */
  lineStrong: grey(0.36, 0.012),
  /** --acc (jade) and --acc-strong. */
  acc: oklchHex(0.79, 0.115, 172),
  accStrong: oklchHex(0.86, 0.12, 172),
  /** --s3: drafts and warnings. */
  warn: oklchHex(0.84, 0.14, 92),
  /** --s1 to --s5: the default severity colours. */
  sev: {
    1: oklchHex(0.7, 0.02, 250),
    2: oklchHex(0.74, 0.08, 235),
    3: oklchHex(0.84, 0.14, 92),
    4: oklchHex(0.74, 0.155, 55),
    5: oklchHex(0.66, 0.19, 25),
  },
} as const;

/**
 * The street map palette: land, water and land use stay a few steps apart in lightness and hue so
 * they read without competing with overlays; roads climb in lightness with their class; labels
 * sit between --fg-3 and --fg-1. Severity hues (red, orange, yellow) and the jade accent are left
 * to the overlays: nothing in the basemap uses them.
 */
export const STREET = {
  background: grey(0.145, 0.008),
  earth: grey(0.185, 0.009),
  water: oklchHex(0.18, 0.036, 236),
  waterLabel: oklchHex(0.62, 0.04, 236),
  park: oklchHex(0.21, 0.02, 165),
  wood: oklchHex(0.2, 0.016, 160),
  scrub: oklchHex(0.195, 0.012, 140),
  sand: oklchHex(0.205, 0.009, 85),
  landuse: grey(0.2, 0.009),
  pedestrian: grey(0.215, 0.009),
  runway: grey(0.27, 0.01),
  pier: grey(0.25, 0.01),
  building: grey(0.235, 0.011),
  casing: grey(0.15, 0.008),
  tunnel: grey(0.23, 0.01),
  tunnelMajor: grey(0.27, 0.01),
  service: grey(0.27, 0.01),
  minor: grey(0.3, 0.011),
  major: grey(0.36, 0.012),
  highway: grey(0.42, 0.014),
  rail: grey(0.33, 0.01),
  boundary: grey(0.45, 0.02),
  labelMinor: grey(0.6, 0.012),
  labelMajor: grey(0.7, 0.012),
  labelPlace: grey(0.6, 0.012),
  labelCity: grey(0.78, 0.01),
  labelState: grey(0.5, 0.012),
  labelCountry: grey(0.68, 0.012),
  labelAddress: grey(0.52, 0.012),
  halo: grey(0.165, 0.009),
  poiBlue: oklchHex(0.64, 0.04, 236),
  poiGreen: oklchHex(0.62, 0.035, 165),
  poiGrey: grey(0.62, 0.012),
} as const;

/**
 * Inline style of every map container: the street map's own background and a dark colour scheme
 * before the first tiles draw and while a status ("Loading map") shows, in either app theme. The
 * `aio-map` class carries the dark MapLibre controls (map.css).
 */
export const MAP_SURFACE = {
  background: STREET.background,
  color: MAP_INK.fg2,
  colorScheme: 'dark',
} as const;
