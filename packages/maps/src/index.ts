import { getAdapter, registerAdapter } from '@aio/engine';

export { MapView, type MapViewProps } from './MapView';
export { captureMap } from './capture';
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
export { frameProjection, lonLatToUtm, utmToLonLat, type FrameProjection } from './geo';
export { buildStyle, BASEMAP_SOURCE, MAP_PROTOCOL } from './style';
export {
  ALL_ISSUES,
  footprint,
  issueAnchor,
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
