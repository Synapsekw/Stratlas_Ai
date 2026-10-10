/**
 * The CesiumJS setup of the Globe (decision 3, plan "CesiumJS in Electron, offline"): a bare
 * `CesiumWidget` from `@cesium/engine` (never the widgets package), no base layer of CesiumJS's
 * choosing (the controller adds ours: the bundled land shapes, street tiles, Natural Earth II
 * from the app's own copy of Cesium's assets; never `ImageryLayer.fromWorldImagery()`), no ion
 * token, no geocoder, no base layer picker, no moon or lens flare, a lowered tile cache.
 * Everything Cesium loads by URL (workers, WebAssembly, assets) comes from `CESIUM_BASE_URL`, the
 * app's `cesium/` folder beside the renderer, so the CSP's `'self'` covers it.
 */
import { Color } from '@cesium/core';
import {
  CesiumWidget,
  Credit,
  CreditDisplay,
  EllipsoidTerrainProvider,
  ImageryLayer,
  SkyAtmosphere,
  SkyBox,
  TileMapServiceImageryProvider,
  buildModuleUrl,
  type TerrainProvider,
} from '@cesium/engine';
import { GLOBE_LOOKS, globePixelRatio, type GlobeLook, type GlobeTierName } from '../look';
import type { GlobePalette, GlobeStyle } from '../style';
import { addAura, type Aura } from './aura';

export type GlobeTier = GlobeTierName;

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

/** Natural Earth II (public domain), bundled with Cesium's assets: the Earth of the old look. */
export function naturalEarthLayer(): ImageryLayer {
  return ImageryLayer.fromProviderAsync(
    TileMapServiceImageryProvider.fromUrl(buildModuleUrl('Assets/Textures/NaturalEarthII'), {
      fileExtension: 'jpg',
    }),
  );
}

export interface GlobeWidgetOptions {
  tier: GlobeTier;
  terrain?: TerrainProvider | undefined;
  creditContainer?: HTMLElement | undefined;
}

export interface GlobeWidget {
  widget: CesiumWidget;
  look: GlobeLook;
  /** Device pixels per CSS pixel the scene is drawn at. */
  pixelRatio: number;
  /** The Globe's own light and air; null on the Low preset. */
  aura: Aura | null;
}

/**
 * A CesiumWidget that makes no request of its own and draws nothing until the controller adds
 * imagery. On the Low preset: one device pixel per CSS pixel, no aura, a higher screen-space
 * error and no terrain (the caller passes none).
 */
export function createOfflineWidget(
  container: HTMLElement,
  o: GlobeWidgetOptions,
  palette: GlobePalette,
): GlobeWidget {
  const look = GLOBE_LOOKS[o.tier];
  const pixelRatio = globePixelRatio(window.devicePixelRatio, look);
  const widget = new CesiumWidget(container, {
    baseLayer: false,
    terrainProvider: o.terrain ?? new EllipsoidTerrainProvider(),
    skyBox: false,
    skyAtmosphere: false,
    ...(o.creditContainer ? { creditContainer: o.creditContainer } : {}),
    // render on change only: the Globe idles at no CPU or GPU cost
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    msaaSamples: look.msaa,
    showRenderLoopErrors: false,
    // sharp on a dense screen, up to what the preset allows
    useBrowserRecommendedResolution: false,
  });
  widget.resolutionScale = pixelRatio / Math.max(window.devicePixelRatio, 0.01);
  const scene = widget.scene;
  if (scene.moon) {
    scene.moon.destroy();
    scene.moon = undefined;
  }
  scene.globe.baseColor = Color.fromCssColorString(palette.water);
  scene.globe.maximumScreenSpaceError = look.screenSpaceError;
  scene.globe.tileCacheSize = look.tileCache;
  scene.globe.depthTestAgainstTerrain = false;
  // far enough to see the whole Earth with room around it, never so far that it is a dot
  scene.screenSpaceCameraController.maximumZoomDistance = 32_000_000;
  scene.screenSpaceCameraController.minimumZoomDistance = 30;
  const aura = look.aura ? addAura(scene, palette, pixelRatio) : null;
  return { widget, look, pixelRatio, aura };
}

/**
 * Dress the scene for a look. The street looks are a drawing: a flat dark backdrop, the aura for
 * light and air (not on Low). Natural Earth keeps the photograph's dress of the first Globe:
 * CesiumJS's star box and atmosphere (neither on Low).
 */
export function dressScene(g: GlobeWidget, style: GlobeStyle, palette: GlobePalette): void {
  const scene = g.widget.scene;
  const painted = style === 'natural-earth';
  const air = painted && g.look.aura;
  scene.backgroundColor = painted ? Color.BLACK : Color.fromCssColorString(palette.space);
  scene.globe.baseColor = painted ? Color.BLACK : Color.fromCssColorString(palette.water);
  if (air && !scene.skyBox) scene.skyBox = SkyBox.createEarthSkyBox();
  if (scene.skyBox) scene.skyBox.show = air;
  if (air && !scene.skyAtmosphere) scene.skyAtmosphere = new SkyAtmosphere();
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = air;
  // the sun's disc and glare belong to the photograph only
  if (scene.sun) scene.sun.show = painted;
  scene.globe.showGroundAtmosphere = air;
  scene.fog.enabled = air;
  scene.globe.enableLighting = false;
  if (g.aura) {
    g.aura.setPalette(palette);
    g.aura.stage.enabled = !painted;
  }
  scene.requestRender();
}
