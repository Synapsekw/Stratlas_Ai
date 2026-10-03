/**
 * Mission palette for the 3D stage (docs/design/DIRECTION.md). sRGB hex approximations of the
 * oklch tokens, because three.js colours are sRGB or linear, not oklch.
 */
export const PALETTE = {
  /** --bg-0 stage surround, oklch(0.145 0.008 250) */
  bg0: 0x15191d,
  /** Sky gradient, dark first: zenith and horizon of the dome. */
  skyZenith: 0x0d1115,
  skyHorizon: 0x2b333c,
  /** Ground grid and plane when the project has no terrain or raster. */
  ground: 0x1c2228,
  groundLine: 0x2a323a,
  /** --acc teal, oklch(0.79 0.115 172) */
  acc: 0x54d4b5,
  accCss: 'oklch(0.79 0.115 172)',
  /** --ov overlay text on imagery, oklch(0.96 0.008 250) */
  ovCss: 'oklch(0.96 0.008 250)',
  ovDimCss: 'oklch(0.96 0.008 250 / .55)',
  ovFaintCss: 'oklch(0.96 0.008 250 / .22)',
  /** Label plate, oklch(0.13 0.01 250 / .84) */
  plateCss: 'oklch(0.13 0.01 250 / .84)',
  hover: 0xdfe6ee,
  measure: 0xffd166,
  water: { deep: 0x0b2a33, shallow: 0x1d5552 },
  sun: 0xfff1dc,
} as const;

export const FONT_MONO = "var(--f-mono, 'IBM Plex Mono', ui-monospace, monospace)";
export const FONT_UI = "var(--f-ui, 'IBM Plex Sans', system-ui, sans-serif)";
