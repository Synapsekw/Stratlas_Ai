/**
 * The CesiumJS setup of the Globe (decision 3, plan "CesiumJS in Electron, offline"): a bare
 * `CesiumWidget` from `@cesium/engine` (never the widgets package), Natural Earth II from the
 * app's own copy of Cesium's assets as the base layer (never `ImageryLayer.fromWorldImagery()`),
 * no ion token, no geocoder, no base layer picker, no moon or lens flare, a lowered tile cache.
 * Everything Cesium loads by URL (workers, WebAssembly, assets) comes from `CESIUM_BASE_URL`, the
 * app's `cesium/` folder beside the renderer, so the CSP's `'self'` covers it.
 */
import {
  CesiumWidget,
  Credit,
  CreditDisplay,
  EllipsoidTerrainProvider,
  ImageryLayer,
  SkyBox,
  TileMapServiceImageryProvider,
  buildModuleUrl,
  type TerrainProvider,
} from '@cesium/engine';

export type GlobeTier = 'low' | 'medium' | 'high' | 'ultra';

/** Point Cesium at the app's own copy of its workers and assets (`<renderer>/cesium/`). */
export function configureCesiumBase(baseUrl: string): void {
  // `setBaseUrl` is public in CesiumJS's source but missing from its type declarations
  (buildModuleUrl as typeof buildModuleUrl & { setBaseUrl(url: string): void }).setBaseUrl(
    baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
  );
  // The default credit is the Cesium ion logo with a link to Cesium's site: ours is the local
  // CesiumJS logo, no link (we never use ion; Apache-2.0 asks for the notice, which About shows).
  CreditDisplay.cesiumCredit = new Credit(
    `<img src="${buildModuleUrl('Assets/Images/cesium_credit.png')}" alt="CesiumJS" title="CesiumJS (Apache-2.0)" style="vertical-align:-7px;height:16px">`,
    true,
  );
}

/** Natural Earth II (public domain), bundled with Cesium's assets: the Globe on first start. */
export async function naturalEarthLayer(): Promise<ImageryLayer> {
  const provider = await TileMapServiceImageryProvider.fromUrl(
    buildModuleUrl('Assets/Textures/NaturalEarthII'),
    { fileExtension: 'jpg' },
  );
  return new ImageryLayer(provider);
}

export interface GlobeWidgetOptions {
  tier: GlobeTier;
  baseLayer: ImageryLayer;
  terrain?: TerrainProvider | undefined;
  creditContainer?: HTMLElement | undefined;
}

/**
 * A CesiumWidget that makes no request of its own. On the Low tier: no atmosphere, no lighting,
 * a higher screen-space error and no terrain (the caller passes none).
 */
export function createOfflineWidget(container: HTMLElement, o: GlobeWidgetOptions): CesiumWidget {
  const low = o.tier === 'low';
  const widget = new CesiumWidget(container, {
    baseLayer: o.baseLayer,
    terrainProvider: o.terrain ?? new EllipsoidTerrainProvider(),
    // the stars only: the moon's texture has no stated provenance (left out of our copy)
    skyBox: low ? false : SkyBox.createEarthSkyBox(),
    ...(low ? { skyAtmosphere: false as const } : {}),
    ...(o.creditContainer ? { creditContainer: o.creditContainer } : {}),
    // render on change only: the Globe idles at no CPU or GPU cost
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    msaaSamples: low ? 1 : 4,
    showRenderLoopErrors: false,
  });
  const scene = widget.scene;
  if (scene.moon) {
    scene.moon.destroy();
    scene.moon = undefined;
  }
  scene.globe.showGroundAtmosphere = !low;
  scene.fog.enabled = !low;
  scene.globe.maximumScreenSpaceError = low ? 4 : 2;
  scene.globe.tileCacheSize = low ? 50 : 100;
  scene.globe.depthTestAgainstTerrain = false;
  return widget;
}
