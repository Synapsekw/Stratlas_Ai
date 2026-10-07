// @aio/globe/view: the Cesium side of the Globe. Import it only from a lazily loaded chunk
// (the renderer's globe screen): it pulls in CesiumJS.
export { GlobeView, type GlobeViewProps } from './GlobeView';
export {
  configureCesiumBase,
  createOfflineWidget,
  naturalEarthLayer,
  type GlobeTier,
} from './setup';
