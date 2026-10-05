import { layers, namedFlavor, type Flavor } from '@protomaps/basemaps';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { STREET } from './ink';

/** Source id of the merged offline basemap (all installed packs behind one tile URL). */
export const BASEMAP_SOURCE = 'basemap';

/** Internal MapLibre protocol registered by @aio/maps (see protocol.ts); never leaves the app. */
export const MAP_PROTOCOL = 'aiomap';

/** Font stacks bundled under packages/maps/assets/fonts (Latin + Arabic ranges). */
export const BUNDLED_FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'] as const;

const S = STREET;

/**
 * Protomaps dark flavour retuned to the Mission palette: the one street style of the app. Every
 * map (Map view, split panes, the 3D ground, road workspace, pickers, Settings coverage, package
 * player) uses it in both app themes.
 */
export const MISSION_DARK: Flavor = {
  ...namedFlavor('dark'),
  background: S.background,
  earth: S.earth,
  park_a: S.park,
  park_b: S.park,
  hospital: S.landuse,
  industrial: S.landuse,
  school: S.landuse,
  wood_a: S.wood,
  wood_b: S.wood,
  pedestrian: S.pedestrian,
  scrub_a: S.scrub,
  scrub_b: S.scrub,
  glacier: S.landuse,
  sand: S.sand,
  beach: S.sand,
  aerodrome: S.landuse,
  runway: S.runway,
  water: S.water,
  zoo: S.park,
  military: S.landuse,
  pier: S.pier,
  buildings: S.building,
  tunnel_other_casing: S.casing,
  tunnel_minor_casing: S.casing,
  tunnel_link_casing: S.casing,
  tunnel_major_casing: S.casing,
  tunnel_highway_casing: S.casing,
  tunnel_other: S.tunnel,
  tunnel_minor: S.tunnel,
  tunnel_link: S.tunnel,
  tunnel_major: S.tunnel,
  tunnel_highway: S.tunnelMajor,
  minor_service_casing: S.casing,
  minor_casing: S.casing,
  link_casing: S.casing,
  major_casing_late: S.casing,
  highway_casing_late: S.casing,
  major_casing_early: S.casing,
  highway_casing_early: S.casing,
  other: S.service,
  minor_service: S.service,
  minor_a: S.minor,
  minor_b: S.minor,
  link: S.major,
  major: S.major,
  highway: S.highway,
  railway: S.rail,
  boundaries: S.boundary,
  bridges_other_casing: S.casing,
  bridges_minor_casing: S.casing,
  bridges_link_casing: S.casing,
  bridges_major_casing: S.casing,
  bridges_highway_casing: S.casing,
  bridges_other: S.service,
  bridges_minor: S.minor,
  bridges_link: S.major,
  bridges_major: S.major,
  bridges_highway: S.highway,
  roads_label_minor: S.labelMinor,
  roads_label_minor_halo: S.halo,
  roads_label_major: S.labelMajor,
  roads_label_major_halo: S.halo,
  ocean_label: S.waterLabel,
  subplace_label: S.labelPlace,
  subplace_label_halo: S.halo,
  city_label: S.labelCity,
  city_label_halo: S.halo,
  state_label: S.labelState,
  state_label_halo: S.halo,
  country_label: S.labelCountry,
  address_label: S.labelAddress,
  address_label_halo: S.halo,
  // POI labels stay muted so they never read as issue severities (red, orange, yellow) or the
  // jade accent of flights and selections.
  pois: {
    blue: S.poiBlue,
    green: S.poiGreen,
    lapis: S.poiBlue,
    pink: S.poiGrey,
    red: S.poiGrey,
    slategray: S.poiGrey,
    tangerine: S.poiGrey,
    turquoise: S.poiBlue,
  },
  landcover: {
    grassland: S.park,
    barren: S.sand,
    urban_area: S.landuse,
    farmland: S.park,
    glacier: S.landuse,
    scrub: S.scrub,
    forest: S.wood,
  },
};

/** The sprite sheet bundled under packages/maps/assets/sprites (Protomaps v4 dark icons). */
export const SPRITE = 'dark';

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
 * Quiet the parts of the Protomaps layers a palette cannot reach: POI icons come pre-coloured from
 * the sprite sheet (green, pink, orange), so they are dimmed to sit under the overlays.
 */
function quiet(list: LayerSpecification[]): LayerSpecification[] {
  return list.map((l) =>
    l.id === 'pois' && l.type === 'symbol'
      ? { ...l, paint: { ...l.paint, 'icon-opacity': 0.5 } }
      : l,
  );
}

/** Name of the one street style (MapLibre `name`); end-to-end tests check it in every theme. */
export const STYLE_NAME = 'Mission dark';

/**
 * The offline basemap style, always dark. Every URL uses the internal `aiomap://` protocol: tiles
 * resolve to the installed packs over aio://packs, glyphs and sprites to files bundled with the app.
 */
export function buildStyle({ lang, maxZoom = 15 }: StyleOptions): StyleSpecification {
  return {
    version: 8,
    name: STYLE_NAME,
    glyphs: `${MAP_PROTOCOL}://glyphs/{fontstack}/{range}.pbf`,
    sprite: `${MAP_PROTOCOL}://sprites/${SPRITE}`,
    sources: {
      [BASEMAP_SOURCE]: {
        type: 'vector',
        tiles: [`${MAP_PROTOCOL}://tiles/{z}/{x}/{y}`],
        minzoom: 0,
        maxzoom: maxZoom,
        attribution: '© OpenStreetMap contributors',
      },
    },
    layers: quiet(bundledFonts(layers(BASEMAP_SOURCE, MISSION_DARK, { lang }))),
  };
}
