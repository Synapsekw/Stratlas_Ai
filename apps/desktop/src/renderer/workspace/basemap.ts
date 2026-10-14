/**
 * What the map of a project draws under its layers, and what the map type picker offers
 * (`BasemapPicker.tsx`): the dark street map alone, the installed imagery packs with the streets
 * and names over them (Satellite), or the imagery alone (Satellite only), plus relief shading from
 * a terrain pack. All of it comes from packs on this computer, with one exception the person
 * switches on: online satellite (Sentinel-2, `ONLINE_SATELLITE`; ADR 0007 amended 10 Oct 2026),
 * which main streams and which then counts as imagery everywhere, under the packs.
 *
 * One model for the picker, the Settings checkboxes, the command palette and the map itself
 * (`useSatelliteMap`), so they cannot disagree: a choice that has no pack to draw from is not
 * offered, and the map then shows the streets whatever was chosen before.
 */
import { frameProjection, orderPacks, packCovers } from '@aio/maps';
import {
  DEFAULT_ONLINE_SOURCE,
  isOnlineBase,
  onlineSatelliteAvailability,
  onlineSource,
  type BaseMapId,
  type MapKeysStatus,
  type OnlineSatelliteAvailability,
  type OnlineSourceId,
  type ProjectManifest,
  type RasterPackInfo,
} from '@aio/schema';
import { drawnBase } from '../maps/mapMenuModel';

export type Basemap = 'streets' | 'satellite' | 'imagery';

/** In the order the picker shows them. */
export const BASEMAPS: readonly Basemap[] = ['streets', 'satellite', 'imagery'];

/** The remembered choices this model reads (`RasterPrefs` of `siteTiles.ts`). */
export interface BasemapPrefs {
  /** Imagery packs on top of the base map. */
  satellite: boolean;
  hillshade: boolean;
  /** Streets and names over the imagery (off: Satellite only). */
  streets: boolean;
  /** The one imagery pack to draw, or null for the best available. */
  imageryPack: string | null;
  /** Online maps are switched on (main holds the switch). */
  onlineSatellite: boolean;
  /** The base map chosen in the Map menu; null until one is chosen there. */
  mapBase?: BaseMapId | null;
}

/** What the model needs to know about online maps beside the switch. */
export interface BasemapOnline {
  /** The online satellite main has for this workstation. */
  source: OnlineSourceId;
  keys: MapKeysStatus;
  offlineOnly: boolean;
}

export const NO_ONLINE: BasemapOnline = {
  source: DEFAULT_ONLINE_SOURCE,
  keys: { esri: false, mapbox: false },
  offlineOnly: false,
};

/**
 * The Map view's base map: the one chosen in the Map menu, or, never chosen there, what 0.11's map
 * type showed: the online satellite under Satellite once online maps were on, else the street map.
 */
export function resolveMapBase(
  prefs: Pick<BasemapPrefs, 'mapBase' | 'satellite' | 'onlineSatellite'>,
  online: Pick<BasemapOnline, 'source'>,
): BaseMapId {
  if (prefs.mapBase) return prefs.mapBase;
  return prefs.satellite && prefs.onlineSatellite ? online.source : 'streets';
}

export type LonLat = readonly [number, number];

/** Where the site is on the Earth (its origin), or null for a project in a local grid. */
export function siteLonLat(
  manifest: Pick<ProjectManifest, 'crs' | 'origin'> | null,
): LonLat | null {
  if (!manifest) return null;
  const proj = frameProjection(manifest.crs, manifest.origin);
  if (!proj) return null;
  const [lon, lat] = proj.toLonLat([0, 0, 0]);
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

/**
 * The packs that cover the site, most detailed first. A site with no known place on the Earth
 * cannot be checked, so every installed pack counts for it.
 */
export function coveringPacks<P extends Pick<RasterPackInfo, 'bbox' | 'maxZoom'>>(
  packs: readonly P[],
  site: LonLat | null,
): P[] {
  return orderPacks(site ? packs.filter((p) => packCovers(p, site[0], site[1])) : packs);
}

/** What the map draws (`syncRasterPacks`, `setStreetOverlay` of `@aio/maps`). */
export interface BasemapDraw {
  imagery: RasterPackInfo[];
  terrain: RasterPackInfo[];
  /** Imagery packs are drawn. */
  satellite: boolean;
  hillshade: boolean;
  /** The streets and names of the basemap over the imagery. */
  streets: boolean;
  /** The online source drawn under the packs, or null. */
  online: OnlineSourceId | null;
}

export interface BasemapModel {
  /** What the map shows now. */
  choice: Basemap;
  /**
   * Satellite and Satellite only can be chosen: an imagery pack covers the site, or online
   * satellite is switched on (it has imagery everywhere).
   */
  satellite: boolean;
  /** Online maps are switched on. */
  online: boolean;
  /** The base map chosen (or derived from 0.11's choices). */
  base: BaseMapId;
  /** The base map drawn: the chosen one, or saved Sentinel-2 or the street map in its place. */
  drawn: BaseMapId;
  /** The chosen base cannot be drawn now. */
  fallback: boolean;
  /** The imagery packs that cover the site, most detailed first. */
  packs: RasterPackInfo[];
  /** The one pack drawn, or null for the best available. */
  pack: string | null;
  /** Terrain shading can be chosen: a terrain pack covers the site. */
  hillshade: boolean;
  /** Terrain shading is on (and there is a pack for it). */
  hillshadeOn: boolean;
  draw: BasemapDraw;
}

/**
 * The basemap of a site from the remembered choices and the installed packs. Satellite draws every
 * installed imagery pack (detailed over coarse, so the map stays covered when panned away from the
 * site), or the one pack chosen; the hillshade draws the most detailed terrain pack at the site.
 * Online satellite, when switched on, is imagery too: it makes Satellite a choice at any site and
 * draws under the packs. Like them it is drawn only when the map type shows imagery.
 */
export function basemapModel(
  prefs: BasemapPrefs,
  imagery: readonly RasterPackInfo[],
  terrain: readonly RasterPackInfo[],
  site: LonLat | null,
  online: BasemapOnline = NO_ONLINE,
): BasemapModel {
  const packs = coveringPacks(imagery, site);
  const relief = coveringPacks(terrain, site);
  const onlineOn = prefs.onlineSatellite;
  const satellite = packs.length > 0 || onlineOn;
  const hillshade = relief.length > 0;
  const one = packs.find((p) => p.id === prefs.imageryPack) ?? null;
  const hillshadeOn = prefs.hillshade && hillshade;
  const base = resolveMapBase(prefs, online);
  const drawn = drawnBase(
    base,
    { enabled: onlineOn, offlineOnly: online.offlineOnly },
    online.keys,
  );
  const drawnSource = isOnlineBase(drawn.base) ? onlineSource(drawn.base) : undefined;
  const packsOn = prefs.satellite && packs.length > 0;
  const imageryUnder = packsOn || (drawnSource?.imagery ?? false);
  // a map with its own street names hides ours; over imagery they follow the switch
  const streets = drawnSource?.labels ? false : imageryUnder ? prefs.streets : true;
  // 0.11's map type, for the picker and the palette until they move to the Map menu (Task 12)
  const choice: Basemap = !(prefs.satellite && satellite)
    ? 'streets'
    : prefs.streets
      ? 'satellite'
      : 'imagery';
  return {
    choice,
    satellite,
    online: onlineOn,
    packs,
    pack: one?.id ?? null,
    hillshade,
    hillshadeOn,
    base,
    drawn: drawn.base,
    fallback: drawn.fallback,
    draw: {
      imagery: !packsOn ? [] : one ? [one] : [...imagery],
      terrain: hillshadeOn ? relief : [],
      satellite: packsOn,
      hillshade: hillshadeOn,
      streets,
      online: drawnSource ? drawnSource.id : null,
    },
  };
}

/** The choices to remember when a map type is picked. */
export function basemapPatch(choice: Basemap): Partial<BasemapPrefs> {
  if (choice === 'streets') return { satellite: false };
  return { satellite: true, streets: choice === 'satellite' };
}

/** What the 3D view can draw around the site, and why not when it cannot. */
export interface GroundModel {
  /** The graphics preset offers terrain and imagery around the site (Medium and up). */
  offered: boolean;
  /** A pack covers the site. */
  imagery: boolean;
  terrain: boolean;
  /** An online map is drawn around the site (the 3D scene's base map). */
  online: boolean;
}

export function groundModel(
  imagery: readonly RasterPackInfo[],
  terrain: readonly RasterPackInfo[],
  site: LonLat | null,
  offered: boolean,
  online = false,
): GroundModel {
  return {
    offered,
    imagery: site !== null && coveringPacks(imagery, site).length > 0,
    terrain: site !== null && coveringPacks(terrain, site).length > 0,
    online: offered && site !== null && online,
  };
}

/** The Online satellite row of the picker: what it shows under each pair of switches. */
export interface OnlineRow {
  availability: OnlineSatelliteAvailability;
  checked: boolean;
  /** Offline only and not on: it cannot be switched on. Once on it can always be switched off. */
  disabled: boolean;
  /** The second line: what it is, why it is greyed, or that only saved tiles are drawn. */
  note: 'detail' | 'offline' | 'saved';
}

export function onlineRow(on: boolean, offlineOnly: boolean): OnlineRow {
  const availability = onlineSatelliteAvailability({ satellite: on, offlineOnly });
  return {
    availability,
    checked: on,
    disabled: offlineOnly && !on,
    note: !offlineOnly ? 'detail' : on ? 'saved' : 'offline',
  };
}
