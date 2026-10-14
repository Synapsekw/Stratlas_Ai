// @aio/globe/view: the CesiumJS side of the Globe. Import it only from a lazily loaded chunk (the
// renderer's Globe screen): it pulls in CesiumJS.
export {
  GlobeView,
  type GlobeIssuePins,
  type GlobeTagText,
  type GlobeViewProps,
} from './GlobeView';
export {
  GlobeController,
  packSource,
  type GlobeControllerOptions,
  type GlobeHover,
  type GlobeInspection,
  type GlobePick,
  type GlobeTagSlot,
  type SourceFor,
} from './controller';
export {
  SiteOutputLayers,
  type SiteOutputRaster,
  type SiteOutputs,
  type SiteRasterRef,
} from './siteOutputs';
export { KitPyramidImageryProvider } from './projectRasterProvider';
export {
  PmtilesImageryProvider,
  packCredit,
  packTerrainProvider,
  type PackTerrainOptions,
} from './providers';
// Online sources (ADR 0007, amended 10 and 14 Oct 2026): the Globe's Satellite look draws one
export {
  OnlineTileImageryProvider,
  createOnlineTileProvider,
  type OnlineTileRead,
} from './onlineTiles';
export {
  EarthImageryProvider,
  TileSourceImageryProvider,
  loadEarthShapes,
  type EarthImageryOptions,
} from './earthLayers';
export {
  configureCesiumBase,
  createOfflineWidget,
  dressScene,
  naturalEarthLayer,
  type GlobeTier,
  type GlobeWidget,
} from './setup';
