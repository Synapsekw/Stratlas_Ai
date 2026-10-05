export type * from './types';
export {
  registerAdapter,
  getAdapter,
  clearAdapters,
  setActiveScene,
  getActiveScene,
  getActiveStage,
  isEngineStage,
  onActiveScene,
} from './registry';
export { SceneView, type SceneViewProps } from './SceneView';
export { configureEngine, type EngineConfig } from './config';
export { registerEngineAdapters } from './adapters/register';
export {
  createPhotosAdapter,
  frustumDepth,
  imageHalfExtents,
  posedPhotos,
  type PosedPhoto,
} from './adapters/photos';
export { registerRasterFormat, type RasterFormatHandler } from './adapters/raster';
export { createPanoramasAdapter } from './adapters/panoramas';
export {
  FULL_SPHERE,
  coverageFromImage,
  panoUv,
  parsePanoIndex,
  type PanoCoverage,
} from './adapters/panoMath';
export type { ViewPreset, CameraPose } from './camera/cameraMath';
export { fitDistance, poseForPreset, frameBox, headingDeg } from './camera/cameraMath';
export { CameraLink, sameView, type LinkableStage } from './camera/cameraLink';
export { meshTemplates } from './adapters/mesh';
export { SharedAssets, type Lease, type SharedStats } from './adapters/shared';
export type { SectionState } from './tools/section';
export { DEFAULT_SECTION } from './tools/section';
export { PALETTE } from './palette';
export { solarPosition, skyDirection, utcOffsetHours, type SolarPosition } from './stage/solar';
export { defaultEnvironment, defaultMode, defaultTime, siteLocation } from './stage/envDefaults';
