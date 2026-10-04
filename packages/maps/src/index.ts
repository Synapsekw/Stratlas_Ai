import { getAdapter, registerAdapter } from '@aio/engine';

export { MapView, type MapViewProps } from './MapView';
export { captureMap } from './capture';
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
export { footprint, issueAnchor, poseAt, rasterQuad, type LonLat } from './overlays';

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
