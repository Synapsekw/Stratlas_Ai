import { z } from 'zod';

/**
 * The online sources (ADR 0007, amendments of 10 and 14 Oct 2026). The original one is Sentinel-2
 * cloudless 2016 by EOX, CC BY 4.0, no key. Off by default; streamed only while the workstation is not offline-only
 * and the person has switched it on (`OnlineSettings.satellite`).
 *
 * This description names no server. The renderer asks the app's own protocol (`tileUrl`,
 * `aio://online/...`); main owns the address of the service, the gate and the cache
 * (`apps/desktop/src/main/onlineTiles.ts`). The map, the Globe and a basemap picker all read the
 * source from here, so they agree on its id, its zoom range and the credit it must carry.
 */
export const ONLINE_SATELLITE = {
  /** The id in `aio://online/<id>/...`, in source and layer ids, and in the cache folder. */
  id: 's2cloudless-2016',
  label: 'Online satellite (Sentinel-2)',
  /**
   * The credit the licence asks for, shown wherever the imagery is drawn and in About: the
   * service's own wording for the 2016 layer, copied from its capabilities document (10 Oct 2026).
   * The address in it is the product's page, not the tile service the app asks.
   */
  attribution:
    'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)',
  licence: 'CC-BY-4.0',
  /** The year of the imagery: it does not show anything built since. */
  year: 2016,
  /** XYZ in Web Mercator, y from the north, as MapLibre and CesiumJS count tiles. */
  tileUrl: 'aio://online/s2cloudless-2016/{z}/{x}/{y}.jpg',
  format: 'jpeg',
  tileSize: 256,
  minZoom: 0,
  /**
   * About 10 m per pixel is the imagery's own resolution: zoom 14 is the deepest tile asked for,
   * and a closer view stretches those tiles instead of requesting deeper ones.
   */
  maxZoom: 14,
} as const;

// ----------------------------------------- online map sources (ADR 0007, amendment of 14 Oct 2026)

/**
 * Every online source, in the order the Map menu shows them inside their group. Main serves them
 * at `aio://online/<id>/<z>/<x>/<y>` (`apps/desktop/src/main/onlineTiles.ts`) and is the only
 * place that knows their servers (`onlineUpstream.ts`); nothing here names one.
 */
export const ONLINE_SOURCE_IDS = [
  'esri-world-imagery',
  'mapbox-satellite',
  's2cloudless-2016',
  'mapbox-streets',
  'mapbox-outdoors',
  'mapbox-light',
  'mapbox-dark',
  'mapbox-satellite-streets',
] as const;
export const OnlineSourceId = z.enum(ONLINE_SOURCE_IDS);
export type OnlineSourceId = z.infer<typeof OnlineSourceId>;

/** The vault accounts of map keys (`map:esri`, `map:mapbox`): kept per computer, never synced. */
export const MAP_KEY_PROVIDERS = ['esri', 'mapbox'] as const;
export const MapKeyProvider = z.enum(MAP_KEY_PROVIDERS);
export type MapKeyProvider = z.infer<typeof MapKeyProvider>;

/** The company that sees the areas viewed (the privacy notice names it, one notice each). */
export type OnlineProvider = 'eox' | MapKeyProvider;
export type OnlineSourceGroup = 'satellite' | 'mapbox';
export type KeyPolicy = 'none' | 'optional' | 'required';
export type TileFormat = 'jpeg' | 'png' | 'webp';

export interface OnlineSource {
  id: OnlineSourceId;
  /** The Map menu's section: Online satellite or Mapbox styles. */
  group: OnlineSourceGroup;
  provider: OnlineProvider;
  /** The vault account of its key; absent when the source takes none. */
  keyProvider?: MapKeyProvider;
  label: string;
  /** The credit its terms ask for, shown wherever it is drawn. Never a URL (the bundle check). */
  attribution: string;
  licence: string;
  keyPolicy: KeyPolicy;
  minZoom: number;
  /** The deepest tile asked for; a closer view stretches it. */
  maxZoom: number;
  /** Edge of a tile in CSS pixels (MapLibre's `tileSize`, Cesium's tile width). */
  tileSize: number;
  /** Edge of the picture main answers with (a `@2x` tile is twice `tileSize`). */
  imagePx: number;
  formats: readonly TileFormat[];
  /** May be kept on disk: Sentinel-2 only, the other providers' terms forbid offline storage. */
  diskCache: boolean;
  /** A photo of the ground (street names may go on top), not a drawn map. */
  imagery: boolean;
  /** The picture has its own street names and roads. */
  labels: boolean;
}

const mapboxStyle = (
  id: OnlineSourceId,
  label: string,
  attribution: string,
  imagery: boolean,
): OnlineSource => ({
  id,
  group: 'mapbox',
  provider: 'mapbox',
  keyProvider: 'mapbox',
  label,
  attribution,
  licence: 'LicenseRef-Mapbox-Terms-of-Service',
  keyPolicy: 'required',
  minZoom: 0,
  maxZoom: 20,
  // Static Tiles at 512 px, asked @2x: 1024 px pictures, sharp on a high density screen
  tileSize: 512,
  imagePx: 1024,
  formats: ['png', 'jpeg', 'webp'],
  diskCache: false,
  imagery,
  labels: true,
});

const OSM_STYLE_CREDIT = '© Mapbox © OpenStreetMap';

export const ONLINE_SOURCES: readonly OnlineSource[] = [
  {
    id: 'esri-world-imagery',
    group: 'satellite',
    provider: 'esri',
    keyProvider: 'esri',
    label: 'Esri World Imagery',
    attribution:
      'Powered by Esri. Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    licence: 'LicenseRef-Esri-Terms-of-Use',
    keyPolicy: 'optional',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    imagePx: 256,
    formats: ['jpeg', 'png'],
    diskCache: false,
    imagery: true,
    labels: false,
  },
  {
    id: 'mapbox-satellite',
    group: 'satellite',
    provider: 'mapbox',
    keyProvider: 'mapbox',
    label: 'Mapbox Satellite',
    attribution: '© Mapbox © Maxar',
    licence: 'LicenseRef-Mapbox-Terms-of-Service',
    keyPolicy: 'required',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    imagePx: 512,
    formats: ['jpeg'],
    diskCache: false,
    imagery: true,
    labels: false,
  },
  {
    id: 's2cloudless-2016',
    group: 'satellite',
    provider: 'eox',
    label: 'Sentinel-2 cloudless 2016 (EOX)',
    attribution: ONLINE_SATELLITE.attribution,
    licence: ONLINE_SATELLITE.licence,
    keyPolicy: 'none',
    minZoom: ONLINE_SATELLITE.minZoom,
    maxZoom: ONLINE_SATELLITE.maxZoom,
    tileSize: ONLINE_SATELLITE.tileSize,
    imagePx: ONLINE_SATELLITE.tileSize,
    formats: ['jpeg'],
    diskCache: true,
    imagery: true,
    labels: false,
  },
  mapboxStyle('mapbox-streets', 'Mapbox Streets', OSM_STYLE_CREDIT, false),
  mapboxStyle('mapbox-outdoors', 'Mapbox Outdoors', OSM_STYLE_CREDIT, false),
  mapboxStyle('mapbox-light', 'Mapbox Light', OSM_STYLE_CREDIT, false),
  mapboxStyle('mapbox-dark', 'Mapbox Dark', OSM_STYLE_CREDIT, false),
  mapboxStyle(
    'mapbox-satellite-streets',
    'Mapbox Satellite Streets',
    `${OSM_STYLE_CREDIT} © Maxar`,
    true,
  ),
];

const SOURCE_BY_ID = new Map<string, OnlineSource>(ONLINE_SOURCES.map((s) => [s.id, s]));

/** The source with this id, or undefined for anything else. */
export function onlineSource(id: string): OnlineSource | undefined {
  return SOURCE_BY_ID.get(id);
}

/** The online satellite of a workstation that switches online maps on for the first time. */
export const DEFAULT_ONLINE_SOURCE: OnlineSourceId = 'esri-world-imagery';

/** The app's own address of a source's tiles, for MapLibre and the other tile clients. */
export function onlineTileTemplate(id: OnlineSourceId): string {
  return `aio://online/${id}/{z}/{x}/{y}`;
}

/** The app's own address of one tile. */
export function onlineTileUrl(id: OnlineSourceId, z: number, x: number, y: number): string {
  return `aio://online/${id}/${String(z)}/${String(x)}/${String(y)}`;
}

/** What a view draws under everything: the offline street map, Natural Earth or a source. */
export const BaseMapId = z.union([
  z.literal('streets'),
  z.literal('natural-earth'),
  OnlineSourceId,
]);
export type BaseMapId = z.infer<typeof BaseMapId>;

export const isOnlineBase = (id: BaseMapId): id is OnlineSourceId =>
  id !== 'streets' && id !== 'natural-earth';

/** `mapKeys:status`: whether this computer holds a key per provider (never the key). */
export const MapKeysStatus = z.object({ esri: z.boolean(), mapbox: z.boolean() });
export type MapKeysStatus = z.infer<typeof MapKeysStatus>;

/**
 * userData `online.json` (`aio.online-settings/1`): what the person allowed this computer to
 * stream. Its own file, not a `Settings` field, so `settings.json` keeps exactly the keys older
 * builds read (as `launch.json` and `globe.json` do). A missing file, or a missing `satellite`,
 * means off. Main reads it for every tile; the renderer changes it only through
 * `onlineTiles:set`.
 */
export const ONLINE_SETTINGS_FILE = 'online.json';
export const ONLINE_SETTINGS_SCHEMA = 'aio.online-settings/1' as const;

export const OnlineSettings = z.looseObject({
  schema: z.literal(ONLINE_SETTINGS_SCHEMA),
  /**
   * Online maps are switched on (14 Oct 2026: every online source, not only Sentinel-2; the name
   * is the one 0.11 reads, so an older build still sees the switch). Absent: off.
   */
  satellite: z.boolean().optional(),
  /**
   * The online satellite this workstation uses (14 Oct 2026, additive). A value this build does
   * not know reads as absent.
   */
  source: OnlineSourceId.optional().catch(undefined),
});
export type OnlineSettings = z.infer<typeof OnlineSettings>;

/** The switch and the source as main uses them. */
export interface OnlineState {
  enabled: boolean;
  source: OnlineSourceId;
}

/**
 * The state a file says. A file written before sources could be chosen has no `source`: a
 * workstation that had Sentinel-2 on keeps it, any other starts on Esri World Imagery.
 */
export function onlineState(s: {
  satellite?: boolean | undefined;
  source?: OnlineSourceId | undefined;
}): OnlineState {
  const enabled = s.satellite === true;
  return { enabled, source: s.source ?? (enabled ? 's2cloudless-2016' : DEFAULT_ONLINE_SOURCE) };
}

/**
 * What main may do for one source: `off` (online maps off), `online` (fetch), `cached` (offline
 * only, but the source keeps tiles on disk: serve those) or `offline` (offline only: nothing).
 */
export type OnlineAvailability = 'off' | 'online' | 'cached' | 'offline';

export function onlineAvailability(
  source: Pick<OnlineSource, 'diskCache'>,
  switches: { enabled: boolean; offlineOnly: boolean },
): OnlineAvailability {
  if (!switches.enabled) return 'off';
  if (!switches.offlineOnly) return 'online';
  return source.diskCache ? 'cached' : 'offline';
}

export const defaultOnlineSettings = (): OnlineSettings => ({ schema: ONLINE_SETTINGS_SCHEMA });

/** Whether online satellite is switched on: only `satellite: true` turns it on. */
export const onlineSatelliteOn = (s: Pick<OnlineSettings, 'satellite'>): boolean =>
  s.satellite === true;

/**
 * What the online satellite source does under the current settings:
 * - `off`: not switched on; nothing is drawn and main refuses every tile.
 * - `online`: tiles for the areas in view are requested from the service and kept in the cache.
 * - `cached`: offline-only is on; areas viewed before still draw from the cache on this computer,
 *   and nothing is requested.
 */
export const OnlineSatelliteAvailability = z.enum(['off', 'online', 'cached']);
export type OnlineSatelliteAvailability = z.infer<typeof OnlineSatelliteAvailability>;

/**
 * The source's state for the two switches: `satellite` of `OnlineSettings` (or of
 * `onlineTiles:status`) and `offlineOnly` of `Settings`.
 */
export function onlineSatelliteAvailability(switches: {
  satellite?: boolean | undefined;
  offlineOnly?: boolean | undefined;
}): OnlineSatelliteAvailability {
  if (switches.satellite !== true) return 'off';
  return switches.offlineOnly === true ? 'cached' : 'online';
}

/** The app's own address of one tile (`ONLINE_SATELLITE.tileUrl` filled in). */
export function onlineSatelliteTileUrl(z: number, x: number, y: number): string {
  return ONLINE_SATELLITE.tileUrl
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/** The cache of online satellite tiles on this computer. */
export const OnlineTileCache = z.object({
  /** Bytes of tiles kept. */
  bytes: z.number().int().nonnegative(),
  tiles: z.number().int().nonnegative(),
  /** The most the cache keeps; the tiles used longest ago go first. */
  capBytes: z.number().int().positive(),
});
export type OnlineTileCache = z.infer<typeof OnlineTileCache>;

/** `onlineTiles:status`: the switch and the source as main has them, and the Sentinel-2 cache. */
export const OnlineTilesStatus = z.object({
  enabled: z.boolean(),
  source: OnlineSourceId,
  cache: OnlineTileCache,
});
export type OnlineTilesStatus = z.infer<typeof OnlineTilesStatus>;
