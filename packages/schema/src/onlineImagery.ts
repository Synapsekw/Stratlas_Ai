import { z } from 'zod';

/**
 * The one online imagery source (ADR 0007, amendment of 10 Oct 2026): Sentinel-2 cloudless 2016 by
 * EOX, CC BY 4.0, no key. Off by default; streamed only while the workstation is not offline-only
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

/**
 * userData `online.json` (`aio.online-settings/1`): what the person allowed this computer to
 * stream. Its own file, not a `Settings` field, so `settings.json` keeps exactly the keys older
 * builds read (as `launch.json` and `globe.json` do). A missing file, or a missing `satellite`,
 * means off. Main reads it for every tile; the renderer changes it only through
 * `onlineTiles:setSatellite`.
 */
export const ONLINE_SETTINGS_FILE = 'online.json';
export const ONLINE_SETTINGS_SCHEMA = 'aio.online-settings/1' as const;

export const OnlineSettings = z.looseObject({
  schema: z.literal(ONLINE_SETTINGS_SCHEMA),
  /** Online satellite (`ONLINE_SATELLITE`) is switched on. Absent: off. */
  satellite: z.boolean().optional(),
});
export type OnlineSettings = z.infer<typeof OnlineSettings>;

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

/** `onlineTiles:status`: the switch as main has it, and the cache. */
export const OnlineTilesStatus = z.object({
  /** Online satellite is switched on (`OnlineSettings.satellite`). */
  satellite: z.boolean(),
  cache: OnlineTileCache,
});
export type OnlineTilesStatus = z.infer<typeof OnlineTilesStatus>;
