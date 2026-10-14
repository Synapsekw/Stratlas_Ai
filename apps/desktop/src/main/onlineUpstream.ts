/**
 * The addresses of the online map services (ADR 0007, amendments of 10 and 14 Oct 2026): the one
 * place in the app that names them. Main only: the renderer asks `aio://online/<id>/...`, and the
 * catalog in `@aio/schema` (`ONLINE_SOURCES`) names no server. A key is added here, in main, and
 * leaves main only inside the request to its own provider.
 */
import type { OnlineSourceId } from '@aio/schema';

export const ONLINE_SATELLITE_HOST = 'tiles.maps.eox.at';

/**
 * The WMTS layer: Sentinel-2 cloudless **2016** in Web Mercator. In the service's capabilities
 * document (`https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml`, read 10 Oct 2026) the
 * 2016 layer is the one without a year in its identifier; `s2cloudless-2016_3857` does not exist.
 *
 * 2016 only, on purpose: it is released under CC BY 4.0. The 2018 to 2025 layers
 * (`s2cloudless-<year>_3857`) are CC BY-NC-SA 4.0, non-commercial, and must never be used here;
 * 2017 is not cleared for use either. Do not change this id without the founder's decision and
 * an amendment to ADR 0007.
 */
export const ONLINE_SATELLITE_LAYER = 's2cloudless_3857';
const MATRIX_SET = 'GoogleMapsCompatible';

/** Esri World Imagery without a key (the public ArcGIS Online service). */
export const ESRI_PUBLIC_HOST = 'server.arcgisonline.com';
/** Esri World Imagery with an ArcGIS Location Platform key (basemap image tiles). */
export const ESRI_KEY_HOST = 'ibasemaps-api.arcgis.com';
/** Mapbox Raster Tiles and Static Tiles APIs. */
export const MAPBOX_HOST = 'api.mapbox.com';

/** The hosts each source may reach; nothing outside this table is ever asked. */
export const ONLINE_HOSTS: Readonly<Record<OnlineSourceId, readonly string[]>> = {
  's2cloudless-2016': [ONLINE_SATELLITE_HOST],
  'esri-world-imagery': [ESRI_PUBLIC_HOST, ESRI_KEY_HOST],
  'mapbox-satellite': [MAPBOX_HOST],
  'mapbox-streets': [MAPBOX_HOST],
  'mapbox-outdoors': [MAPBOX_HOST],
  'mapbox-light': [MAPBOX_HOST],
  'mapbox-dark': [MAPBOX_HOST],
  'mapbox-satellite-streets': [MAPBOX_HOST],
};

/** The Mapbox style of each style source (Static Tiles API, `mapbox` account styles). */
export const MAPBOX_STYLES = {
  'mapbox-streets': 'streets-v12',
  'mapbox-outdoors': 'outdoors-v12',
  'mapbox-light': 'light-v11',
  'mapbox-dark': 'dark-v11',
  'mapbox-satellite-streets': 'satellite-streets-v12',
} as const;

const n = (v: number) => String(v);

function needKey(key: string | null): string {
  if (!key) throw new Error('This source needs a key');
  return encodeURIComponent(key);
}

/**
 * The service's address of a tile. WMTS and ArcGIS count z/y/x (row before column); Mapbox and
 * the app's own address count z/x/y.
 */
export function upstreamTileUrl(
  id: OnlineSourceId,
  z: number,
  x: number,
  y: number,
  key: string | null,
): string {
  switch (id) {
    case 's2cloudless-2016':
      return `https://${ONLINE_SATELLITE_HOST}/wmts/1.0.0/${ONLINE_SATELLITE_LAYER}/default/${MATRIX_SET}/${n(z)}/${n(y)}/${n(x)}.jpg`;
    case 'esri-world-imagery':
      return key
        ? `https://${ESRI_KEY_HOST}/arcgis/rest/services/World_Imagery/MapServer/tile/${n(z)}/${n(y)}/${n(x)}?token=${encodeURIComponent(key)}`
        : `https://${ESRI_PUBLIC_HOST}/ArcGIS/rest/services/World_Imagery/MapServer/tile/${n(z)}/${n(y)}/${n(x)}`;
    case 'mapbox-satellite':
      return `https://${MAPBOX_HOST}/v4/mapbox.satellite/${n(z)}/${n(x)}/${n(y)}@2x.jpg90?access_token=${needKey(key)}`;
    default:
      return `https://${MAPBOX_HOST}/styles/v1/mapbox/${MAPBOX_STYLES[id]}/tiles/512/${n(z)}/${n(x)}/${n(y)}@2x?access_token=${needKey(key)}`;
  }
}
