// Pack and asset definitions for build-packs.mjs. Order matters: small packs first so street
// detail for both M1 sites (Al-Zour, HCl in Kuwait) is available early.

/** @type {{ id: string, label: string, bbox: [number, number, number, number], maxZoom: number }[]} */
export const PACKS = [
  { id: 'kuwait', label: 'Kuwait streets', bbox: [46.5, 28.5, 48.5, 30.1], maxZoom: 15 },
  { id: 'world', label: 'World overview', bbox: [-180, -85, 180, 85], maxZoom: 6 },
  { id: 'gcc', label: 'GCC streets', bbox: [34.5, 12.0, 60.0, 32.5], maxZoom: 15 },
];

/** Font stacks used by the @protomaps/basemaps layers. */
export const ASSET_FONTSTACKS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];

/**
 * Glyph ranges bundled offline: Latin (basic, supplement, extended, punctuation) and Arabic
 * (Arabic, supplement, extended-A, presentation forms A and B).
 */
export const ASSET_GLYPH_RANGES = [
  '0-255',
  '256-511',
  '8192-8447',
  '1536-1791',
  '1792-2047',
  '2048-2303',
  '64256-64511',
  '64512-64767',
  '64768-65023',
  '65024-65279',
];

/** Protomaps v4 sprite sheets. */
export const ASSET_SPRITES = ['dark', 'light'];
