export { MapView, type MapViewProps } from './MapView';
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

/** Registers basemap and raster ground adapters with @aio/engine. Owner: stream S5. Phase 0: no-op. */
export function registerMapAdapters(): void {
  /* implemented by stream S5 */
}
