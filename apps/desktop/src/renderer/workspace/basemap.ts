/**
 * What the map of a project draws under its layers: the base map chosen in the Map menu
 * (`MapMenus.tsx`; the street map, an online source, or what 0.11's map type showed), the
 * installed imagery packs on top of it, relief shading from a terrain pack and the streets and
 * names over imagery. An online source is drawn only when main can serve it (`drawnBase`);
 * otherwise the street map takes its place.
 *
 * One model for the Map menu, the Settings checkboxes, the command palette and the map itself
 * (`useSatelliteMap`), so they cannot disagree: a choice that has no pack to draw from is not
 * offered, and the map then shows the streets whatever was chosen before.
 */
import { frameProjection, orderPacks, packCovers } from '@aio/maps';
import {
  DEFAULT_ONLINE_SOURCE,
  isOnlineBase,
  onlineSource,
  type BaseMapId,
  type MapKeysStatus,
  type OnlineSourceId,
  type ProjectManifest,
  type RasterPackInfo,
} from '@aio/schema';
import { drawnBase } from '../maps/mapMenuModel';

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

const onlineOf = (prefs: Pick<BasemapPrefs, 'onlineSatellite'>, online: BasemapOnline) => ({
  enabled: prefs.onlineSatellite,
  offlineOnly: online.offlineOnly,
});

/** The workstation's online satellite can be drawn now. */
function onlineImagery(prefs: Pick<BasemapPrefs, 'onlineSatellite'>, online: BasemapOnline) {
  return !drawnBase(online.source, onlineOf(prefs, online), online.keys).fallback;
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
  /**
   * Imagery can be drawn at the site: an imagery pack covers it, or the workstation's online
   * satellite can be drawn (online maps on, its key held, not offline-only; it has imagery
   * everywhere). Place walk reads it (`placeLook`) before it turns the map to imagery.
   */
  satellite: boolean;
  /** Online maps are switched on. */
  online: boolean;
  /** The base map chosen (or derived from 0.11's choices). */
  base: BaseMapId;
  /** The base map drawn: the chosen one, or the street map in its place. */
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
 * The basemap of a site from the remembered choices and the installed packs. Imagery packs on top
 * draw every installed imagery pack (detailed over coarse, so the map stays covered when panned
 * away from the site), or the one pack chosen; the hillshade draws the most detailed terrain pack
 * at the site. The base map under them is the one chosen in the Map menu, when it can be drawn.
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
  const satellite = packs.length > 0 || onlineImagery(prefs, online);
  const hillshade = relief.length > 0;
  const one = packs.find((p) => p.id === prefs.imageryPack) ?? null;
  const hillshadeOn = prefs.hillshade && hillshade;
  const base = resolveMapBase(prefs, online);
  const drawn = drawnBase(base, onlineOf(prefs, online), online.keys);
  const drawnSource = isOnlineBase(drawn.base) ? onlineSource(drawn.base) : undefined;
  const packsOn = prefs.satellite && packs.length > 0;
  const imageryUnder = packsOn || (drawnSource?.imagery ?? false);
  // a map with its own street names hides ours; over imagery they follow the switch
  const streets = drawnSource?.labels ? false : imageryUnder ? prefs.streets : true;
  return {
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

/** What Place walk needs to show imagery under a walk placed on the map. */
export interface PlaceLook {
  /** Any imagery can be drawn at the site (`BasemapModel.satellite`). */
  imagery: boolean;
  /** The choices that show it, or null when it is shown already or there is none. */
  switchTo: Partial<Pick<BasemapPrefs, 'satellite' | 'streets' | 'mapBase'>> | null;
}

/**
 * Imagery under a walk placed on the map: the imagery packs on top when one covers the site,
 * otherwise the workstation's online satellite as the base map, when it can be drawn.
 */
export function placeLook(
  prefs: BasemapPrefs,
  imagery: readonly RasterPackInfo[],
  terrain: readonly RasterPackInfo[],
  site: LonLat | null,
  online: BasemapOnline = NO_ONLINE,
): PlaceLook {
  const m = basemapModel(prefs, imagery, terrain, site, online);
  const drawnImagery = isOnlineBase(m.drawn) && (onlineSource(m.drawn)?.imagery ?? false);
  if (!m.satellite) return { imagery: false, switchTo: null };
  if (m.draw.satellite || drawnImagery) return { imagery: true, switchTo: null };
  return {
    imagery: true,
    switchTo:
      m.packs.length > 0
        ? { satellite: true, streets: true }
        : { mapBase: online.source, streets: true },
  };
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
