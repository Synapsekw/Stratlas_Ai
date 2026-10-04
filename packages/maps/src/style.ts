import { layers, namedFlavor, type Flavor } from '@protomaps/basemaps';
import type { StyleSpecification } from 'maplibre-gl';

/** Source id of the merged offline basemap (all installed packs behind one tile URL). */
export const BASEMAP_SOURCE = 'basemap';

/** Internal MapLibre protocol registered by @aio/maps (see protocol.ts); never leaves the app. */
export const MAP_PROTOCOL = 'aiomap';

/** Font stacks bundled under packages/maps/assets/fonts (Latin + Arabic ranges). */
export const BUNDLED_FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'] as const;

// Mission tokens (packages/ui/src/tokens.css, dark) converted from oklch to sRGB hex, plus a few
// map-only tints in the same hue family. MapLibre does not parse oklch.
const C = {
  bg0: '#080a0d',
  bg1: '#0e1114',
  bg2: '#14181c',
  bg3: '#1b2024',
  line: '#24282d',
  lineStrong: '#383e43',
  fg1: '#b9bec4',
  fg2: '#878d93',
  fg3: '#5e646a',
  fg4: '#43484e',
  water: '#0a1a24',
  park: '#0d1913',
  sand: '#15130f',
  building: '#1a1f23',
  road: '#2a3036',
  roadMajor: '#3a4249',
  highway: '#4f5962',
} as const;

/** Protomaps dark flavour retuned to the Mission palette. */
export const MISSION_DARK: Flavor = {
  ...namedFlavor('dark'),
  background: C.bg0,
  earth: C.bg1,
  park_a: C.park,
  park_b: C.park,
  hospital: C.bg2,
  industrial: C.bg2,
  school: C.bg2,
  wood_a: C.park,
  wood_b: C.park,
  pedestrian: C.bg2,
  scrub_a: C.bg1,
  scrub_b: C.bg1,
  glacier: C.bg2,
  sand: C.sand,
  beach: C.sand,
  aerodrome: C.bg2,
  runway: C.bg3,
  water: C.water,
  zoo: C.bg2,
  military: C.bg2,
  pier: C.bg3,
  buildings: C.building,
  tunnel_other_casing: C.bg0,
  tunnel_minor_casing: C.bg0,
  tunnel_link_casing: C.bg0,
  tunnel_major_casing: C.bg0,
  tunnel_highway_casing: C.bg0,
  tunnel_other: C.bg2,
  tunnel_minor: C.bg2,
  tunnel_link: C.bg2,
  tunnel_major: C.bg2,
  tunnel_highway: C.bg3,
  minor_service_casing: C.bg1,
  minor_casing: C.bg1,
  link_casing: C.bg1,
  major_casing_late: C.bg1,
  highway_casing_late: C.bg1,
  major_casing_early: C.bg1,
  highway_casing_early: C.bg1,
  other: C.road,
  minor_service: C.road,
  minor_a: C.road,
  minor_b: C.road,
  link: C.roadMajor,
  major: C.roadMajor,
  highway: C.highway,
  railway: C.line,
  boundaries: C.lineStrong,
  bridges_other_casing: C.bg1,
  bridges_minor_casing: C.bg1,
  bridges_link_casing: C.bg1,
  bridges_major_casing: C.bg1,
  bridges_highway_casing: C.bg1,
  bridges_other: C.road,
  bridges_minor: C.road,
  bridges_link: C.roadMajor,
  bridges_major: C.roadMajor,
  bridges_highway: C.highway,
  roads_label_minor: C.fg3,
  roads_label_minor_halo: C.bg1,
  roads_label_major: C.fg2,
  roads_label_major_halo: C.bg1,
  ocean_label: C.fg3,
  subplace_label: C.fg3,
  subplace_label_halo: C.bg0,
  city_label: C.fg1,
  city_label_halo: C.bg0,
  state_label: C.fg4,
  state_label_halo: C.bg0,
  country_label: C.fg2,
  address_label: C.fg4,
  address_label_halo: C.bg1,
  // POI icons stay muted so they never read as issue severities (red, orange, yellow) on the map.
  pois: {
    blue: '#78b3d6',
    green: '#7bcc98',
    lapis: '#78b3d6',
    pink: C.fg1,
    red: C.fg1,
    slategray: C.fg2,
    tangerine: C.fg1,
    turquoise: '#78b3d6',
  },
  landcover: {
    grassland: C.park,
    barren: C.sand,
    urban_area: C.bg2,
    farmland: C.park,
    glacier: C.bg2,
    scrub: C.bg1,
    forest: C.park,
  },
};

// Light Mission tokens (tokens.css, data-theme light) in sRGB hex, plus map-only tints.
const L = {
  bg0: '#e5e8ec',
  bg1: '#f5f6f8',
  bg2: '#eceef1',
  bg3: '#dfe2e6',
  line: '#d0d4d9',
  lineStrong: '#b1b6bd',
  fg1: '#383d44',
  fg2: '#585e66',
  fg3: '#737980',
  fg4: '#959aa1',
  water: '#c6d8e3',
  park: '#d9e6da',
  sand: '#eee8da',
  building: '#dcdfe3',
  road: '#ffffff',
  roadMajor: '#ffffff',
  highway: '#f6f1e6',
  casing: '#cdd2d8',
} as const;

/** Protomaps light flavour retuned to the light Mission palette (MAP-4). */
export const MISSION_LIGHT: Flavor = {
  ...namedFlavor('light'),
  background: L.bg0,
  earth: L.bg1,
  park_a: L.park,
  park_b: L.park,
  hospital: L.bg2,
  industrial: L.bg2,
  school: L.bg2,
  wood_a: L.park,
  wood_b: L.park,
  pedestrian: L.bg2,
  scrub_a: L.bg1,
  scrub_b: L.bg1,
  glacier: L.bg2,
  sand: L.sand,
  beach: L.sand,
  aerodrome: L.bg2,
  runway: L.bg3,
  water: L.water,
  zoo: L.bg2,
  military: L.bg2,
  pier: L.bg3,
  buildings: L.building,
  tunnel_other_casing: L.casing,
  tunnel_minor_casing: L.casing,
  tunnel_link_casing: L.casing,
  tunnel_major_casing: L.casing,
  tunnel_highway_casing: L.casing,
  tunnel_other: L.bg2,
  tunnel_minor: L.bg2,
  tunnel_link: L.bg2,
  tunnel_major: L.bg2,
  tunnel_highway: L.bg3,
  minor_service_casing: L.casing,
  minor_casing: L.casing,
  link_casing: L.casing,
  major_casing_late: L.casing,
  highway_casing_late: L.casing,
  major_casing_early: L.casing,
  highway_casing_early: L.casing,
  other: L.road,
  minor_service: L.road,
  minor_a: L.road,
  minor_b: L.road,
  link: L.roadMajor,
  major: L.roadMajor,
  highway: L.highway,
  railway: L.lineStrong,
  boundaries: L.lineStrong,
  bridges_other_casing: L.casing,
  bridges_minor_casing: L.casing,
  bridges_link_casing: L.casing,
  bridges_major_casing: L.casing,
  bridges_highway_casing: L.casing,
  bridges_other: L.road,
  bridges_minor: L.road,
  bridges_link: L.roadMajor,
  bridges_major: L.roadMajor,
  bridges_highway: L.highway,
  roads_label_minor: L.fg3,
  roads_label_minor_halo: L.bg1,
  roads_label_major: L.fg2,
  roads_label_major_halo: L.bg1,
  ocean_label: L.fg3,
  subplace_label: L.fg3,
  subplace_label_halo: L.bg1,
  city_label: L.fg1,
  city_label_halo: L.bg1,
  state_label: L.fg4,
  state_label_halo: L.bg1,
  country_label: L.fg2,
  address_label: L.fg4,
  address_label_halo: L.bg1,
  // POI icons stay muted so they never read as issue severities on the map.
  pois: {
    blue: '#4f7f9e',
    green: '#4f8a63',
    lapis: '#4f7f9e',
    pink: L.fg2,
    red: L.fg2,
    slategray: L.fg3,
    tangerine: L.fg2,
    turquoise: '#4f7f9e',
  },
  landcover: {
    grassland: L.park,
    barren: L.sand,
    urban_area: L.bg2,
    farmland: L.park,
    glacier: L.bg2,
    scrub: L.bg1,
    forest: L.park,
  },
};

export interface StyleOptions {
  /** Label language: English (with the Arabic local name beneath) or Arabic. */
  lang: 'en' | 'ar';
  /** Follows the app theme. Default dark. */
  flavour?: 'dark' | 'light';
  /** Highest zoom any installed pack reaches; MapLibre overzooms beyond it. */
  maxZoom?: number;
}

/** Replaces font stacks that are not bundled (e.g. Devanagari) with the regular stack. */
function bundledFonts<T>(v: T): T {
  if (typeof v === 'string')
    return (
      v.startsWith('Noto Sans') && !(BUNDLED_FONTS as readonly string[]).includes(v)
        ? 'Noto Sans Regular'
        : v
    ) as T;
  if (Array.isArray(v)) return v.map(bundledFonts) as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, bundledFonts(x)]),
    ) as T;
  return v;
}

/**
 * The offline basemap style. Every URL uses the internal `aiomap://` protocol: tiles resolve to the
 * installed packs over aio://packs, glyphs and sprites to files bundled with the app.
 */
export function buildStyle({
  lang,
  maxZoom = 15,
  flavour = 'dark',
}: StyleOptions): StyleSpecification {
  return {
    version: 8,
    name: `Mission ${flavour}`,
    glyphs: `${MAP_PROTOCOL}://glyphs/{fontstack}/{range}.pbf`,
    sprite: `${MAP_PROTOCOL}://sprites/${flavour}`,
    sources: {
      [BASEMAP_SOURCE]: {
        type: 'vector',
        tiles: [`${MAP_PROTOCOL}://tiles/{z}/{x}/{y}`],
        minzoom: 0,
        maxzoom: maxZoom,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: bundledFonts(
      layers(BASEMAP_SOURCE, flavour === 'light' ? MISSION_LIGHT : MISSION_DARK, { lang }),
    ),
  };
}
