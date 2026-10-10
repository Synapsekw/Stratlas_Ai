import { getAdapter, registerAdapter, type AdapterContext, type LayerHandle } from '@aio/engine';
import type { Layer } from '@aio/schema';
import type { GroundExtent } from './ground';
import type { MapPack } from './packs';
import type { StreetTileOptions, StreetTiles } from './streetTiles';

export { MapView, type MapViewProps } from './MapView';
export { captureMap, getActiveMap, onActiveMap } from './capture';
export { PackCoverage, type PackCoverageProps } from './PackCoverage';
export { bboxPolygon, coverageFeatures, dragBbox } from './coverageData';
export { estimatePackBytes, normaliseBbox, tileCount, type PackEstimate } from './estimate';
export { COUNTRIES, GCC_IDS, packIdFor, regionById, type Region } from './regions';
export { LocationPicker, type LocationPickerProps } from './LocationPicker';
export {
  drawPreview,
  isRepeatClick,
  type MapDrawMode,
  type MapDrawSeam,
  type MapLngLat,
} from './draw';
export {
  bboxOf,
  orderPacks,
  packCovers,
  packFileUrl,
  packsForTile,
  packUrl,
  tileBbox,
  zoomForBbox,
  type Bbox,
  type MapPack,
} from './packs';
export { extentBbox, siteBbox, type GroundExtent } from './ground';
export { frameProjection, lonLatToUtm, utmToLonLat, type FrameProjection } from './geo';
export { buildStyle, BASEMAP_SOURCE, MAP_PROTOCOL } from './style';
export {
  ALL_ISSUES,
  footprint,
  headingLine,
  issueAnchor,
  overlayTiles,
  poseAt,
  rasterQuad,
  severityRankColors,
  type LonLat,
  type MapIssueDisplay,
} from './overlays';
export {
  issueFeatures,
  issueShapeBounds,
  lineLengthM,
  polygonAreaM2,
  styleLayers,
  type IssueFeatureOptions,
  type IssueFeatureSet,
  type MapOverlay,
  type OverlayLayer,
} from './vector';
export {
  levelMetresPerPx,
  pyramidView,
  type GroundBox,
  type PyramidIndex,
  type PyramidTile,
} from './pyramid';
export type { IssueColorBy, MapController } from './controller';
// M8 C2: swipe and blend of two dates, the look of change results
export * from './swipe';
export * from './changeStyle';
// M10 G7: imagery and terrain packs on the map (Satellite, hillshade)
export * from './rasterPacks';

/**
 * Registers the `basemap` ground adapter with @aio/engine: the offline street style rendered once
 * around the project origin (5 km square) and draped as a ground quad. Idempotent.
 */
export function registerMapAdapters(): void {
  if (getAdapter('basemap')) return;
  registerAdapter({
    kind: 'basemap',
    create: async (layer, ctx) => {
      // MapLibre loads lazily, only when a project actually has a basemap layer.
      const { createGround } = await import('./groundRender');
      return createGround(layer, ctx);
    },
  });
}

// The street map on the Globe: the street style's colours, which tiles are worth drawing, and
// the tiles themselves (MapLibre loads lazily, only when the Globe opens with street packs).
export { STREET } from './ink';
export { STREET_MAX_LEVEL, STREET_OVERZOOM, streetCover, type StreetCover } from './streetCover';
export type { StreetTileOptions, StreetTileStats, StreetTiles } from './streetTiles';

/**
 * The street map as Web Mercator raster tiles drawn from the installed street packs, for the
 * Globe (`streetTiles.ts`); null without packs.
 */
export async function createStreetTiles(
  packs: readonly MapPack[],
  options: StreetTileOptions = {},
): Promise<StreetTiles | null> {
  const { createStreetTiles: create } = await import('./streetTiles');
  return create(packs, options);
}

/**
 * The street map ground over a chosen rectangle of the local frame (the 3D street map under a
 * site, sized to what the project covers), without a manifest layer. MapLibre loads lazily.
 */
export async function createStreetGround(
  layer: Extract<Layer, { kind: 'basemap' }>,
  ctx: AdapterContext,
  extent: GroundExtent,
): Promise<LayerHandle> {
  const { createGround } = await import('./groundRender');
  return createGround(layer, ctx, { extent });
}
