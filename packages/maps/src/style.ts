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
  road: '#22272c',
  roadMajor: '#2c3238',
  highway: '#3a424a',
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

export interface StyleOptions {
  /** Label language: English (with the Arabic local name beneath) or Arabic. */
  lang: 'en' | 'ar';
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
export function buildStyle({ lang, maxZoom = 15 }: StyleOptions): StyleSpecification {
  return {
    version: 8,
    name: 'Mission dark',
    glyphs: `${MAP_PROTOCOL}://glyphs/{fontstack}/{range}.pbf`,
    sprite: `${MAP_PROTOCOL}://sprites/dark`,
    sources: {
      [BASEMAP_SOURCE]: {
        type: 'vector',
        tiles: [`${MAP_PROTOCOL}://tiles/{z}/{x}/{y}`],
        minzoom: 0,
        maxzoom: maxZoom,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: bundledFonts(layers(BASEMAP_SOURCE, MISSION_DARK, { lang })),
  };
}
