/**
 * The offline rules of the Globe (decision 3, plan "CesiumJS in Electron, offline"). G6 builds the
 * CesiumJS setup on these; the lint rule (`eslint.config.js`) and the bundle check
 * (`tools/release/check-bundle.mjs`) use the same lists, so a Cesium path that would reach the
 * network fails before it ships.
 */

/**
 * CesiumJS exports that reach Cesium ion, Bing, Google or another online service, or that need
 * `'unsafe-eval'` (the widgets package). Banned in `packages/globe` and the renderer.
 */
export const BANNED_CESIUM_IMPORTS: readonly string[] = [
  'Ion',
  'IonResource',
  'IonImageryProvider',
  'IonGeocoderService',
  'createWorldImageryAsync',
  'createWorldTerrainAsync',
  'createOsmBuildingsAsync',
  'createGooglePhotorealistic3DTileset',
  'BingMapsImageryProvider',
  'BingMapsGeocoderService',
  'GoogleEarthEnterpriseImageryProvider',
  'GoogleEarthEnterpriseTerrainProvider',
  'GoogleEarthEnterpriseMetadata',
  'GoogleMaps',
  'GoogleGeocoderService',
  'ITwinData',
  'ITwinPlatform',
  'ArcGisMapServerImageryProvider',
  'ArcGisMapService',
  'MapboxImageryProvider',
  'MapboxStyleImageryProvider',
];

/** Packages that must never be imported (Knockout in the widgets runs `eval`). */
export const BANNED_CESIUM_PACKAGES: readonly string[] = ['cesium', '@cesium/widgets'];

/**
 * Hosts that no built renderer file may name (plan "Review focus", zero network with Cesium). The
 * bundle check looks for them in the Globe's chunk and the copied Cesium assets.
 */
export const ONLINE_GLOBE_HOSTS: readonly string[] = [
  'cesium.com',
  'virtualearth.net',
  'googleapis.com',
  'arcgisonline.com',
  'mapbox.com',
];

/** Where the app's own copy of Cesium's `Workers/`, `Assets/` and `ThirdParty/` is served. */
export const CESIUM_BASE_PATH = 'cesium/';

/** What the Globe's CesiumWidget is built with: nothing that calls out, our own base layer. */
export const OFFLINE_CESIUM = {
  /** `Ion.defaultAccessToken` is never set and nothing of ours reaches `Ion.defaultServer`. */
  ionToken: null,
  /**
   * The Earth is drawn from what the app ships or the person installed, never
   * `ImageryLayer.fromWorldImagery()`: the bundled land and border shapes (with street tiles
   * from the installed street packs over them) by default.
   */
  baseLayer: 'earth-shapes',
  /** The old look's Earth: Natural Earth II from the app's own copy of Cesium's assets. */
  naturalEarth: 'natural-earth-ii',
  geocoder: false,
  baseLayerPicker: false,
  /** Lowered from Cesium's 512 MiB default; the Globe owns the GPU only while it is open. */
  tileCacheBytes: 256 * 2 ** 20,
} as const;

/** The hosts a piece of text names (for the bundle check and tests). */
export function onlineHostsIn(text: string): string[] {
  return ONLINE_GLOBE_HOSTS.filter((h) => text.includes(h));
}

/** Where a rewritten online host points: a reserved name that never resolves (RFC 2606). */
export const OFFLINE_HOST = 'offline.invalid';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Built on first use, so the renderer's Globe chunk (which never rewrites code) leaves it out. */
const onlineHostRe = () =>
  new RegExp(`(?:[a-z0-9-]+\\.)*(?:${ONLINE_GLOBE_HOSTS.map(escape).join('|')})`, 'gi');

/**
 * CesiumJS source with every online host (and its subdomains: `api.cesium.com`,
 * `dev.virtualearth.net`, `tile.googleapis.com`) rewritten to {@link OFFLINE_HOST}. The renderer
 * build runs it over the bundled Cesium modules (`electron.vite.config.ts`), so a default URL we
 * never use cannot name a real server, and the bundle check finds no online host in the build.
 */
export function offlineSource(code: string): string {
  return code.replace(onlineHostRe(), OFFLINE_HOST);
}
