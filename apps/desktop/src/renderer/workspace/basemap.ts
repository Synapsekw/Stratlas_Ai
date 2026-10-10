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
  onlineSatelliteAvailability,
  type OnlineSatelliteAvailability,
  type ProjectManifest,
  type RasterPackInfo,
} from '@aio/schema';

export type Basemap = 'streets' | 'satellite' | 'imagery';

/** In the order the picker shows them. */
export const BASEMAPS: readonly Basemap[] = ['streets', 'satellite', 'imagery'];

/** The remembered choices this model reads (`RasterPrefs` of `siteTiles.ts`). */
export interface BasemapPrefs {
  satellite: boolean;
  hillshade: boolean;
  /** Streets and names over the imagery (off: Satellite only). */
  streets: boolean;
  /** The one imagery pack to draw, or null for the best available. */
  imageryPack: string | null;
  /** Online satellite (Sentinel-2) is switched on (main holds the switch). */
  onlineSatellite: boolean;
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
  satellite: boolean;
  hillshade: boolean;
  /** The streets and names of the basemap over the imagery. */
  streets: boolean;
  /** Online satellite under the packs: imagery everywhere, also where no pack reaches. */
  online: boolean;
}

export interface BasemapModel {
  /** What the map shows now. */
  choice: Basemap;
  /**
   * Satellite and Satellite only can be chosen: an imagery pack covers the site, or online
   * satellite is switched on (it has imagery everywhere).
   */
  satellite: boolean;
  /** Online satellite is switched on. */
  online: boolean;
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
): BasemapModel {
  const packs = coveringPacks(imagery, site);
  const relief = coveringPacks(terrain, site);
  const online = prefs.onlineSatellite;
  const satellite = packs.length > 0 || online;
  const hillshade = relief.length > 0;
  const one = packs.find((p) => p.id === prefs.imageryPack) ?? null;
  const satelliteOn = prefs.satellite && satellite;
  const hillshadeOn = prefs.hillshade && hillshade;
  const choice: Basemap = !satelliteOn ? 'streets' : prefs.streets ? 'satellite' : 'imagery';
  return {
    choice,
    satellite,
    online,
    packs,
    pack: one?.id ?? null,
    hillshade,
    hillshadeOn,
    draw: {
      imagery: !satelliteOn ? [] : one ? [one] : [...imagery],
      terrain: hillshadeOn ? relief : [],
      satellite: satelliteOn,
      hillshade: hillshadeOn,
      streets: choice !== 'imagery',
      online: satelliteOn && online,
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
}

export function groundModel(
  imagery: readonly RasterPackInfo[],
  terrain: readonly RasterPackInfo[],
  site: LonLat | null,
  offered: boolean,
): GroundModel {
  return {
    offered,
    imagery: site !== null && coveringPacks(imagery, site).length > 0,
    terrain: site !== null && coveringPacks(terrain, site).length > 0,
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
