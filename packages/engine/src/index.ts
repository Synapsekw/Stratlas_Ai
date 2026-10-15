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
export {
  FAR_M,
  configureEngine,
  type EngineConfig,
  type EngineMemory,
  type EngineText,
  type EngineTextKey,
  type GpuEvent,
} from './config';
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
export { PANO_SPHERE_R, panoSphereMaterial, type PanoSphereMaterial } from './adapters/panoSphere';
export {
  FULL_SPHERE,
  PANO_FOV,
  azElToDir,
  coverageFromImage,
  dragLook,
  imageCentreDeg,
  itemCoverage,
  panoOpenable,
  panoUv,
  parsePanoIndex,
  startLook,
  zoomLook,
  type PanoCoverage,
  type PanoLook,
} from './adapters/panoMath';
export type { ViewPreset, CameraPose } from './camera/cameraMath';
export { fitDistance, poseForPreset, frameBox, headingDeg } from './camera/cameraMath';
export { CameraLink, sameView, type LinkableStage } from './camera/cameraLink';
export { meshTemplates } from './adapters/mesh';
export { SharedAssets, type Lease, type SharedStats } from './adapters/shared';
export type { SectionState } from './tools/section';
export { DEFAULT_SECTION } from './tools/section';
export {
  ClipBoxTool,
  MIN_SIZE_M,
  SNAP_M,
  boxAxes,
  closestOnLine,
  dragFace,
  faceCentre,
  faceNormal,
  formatBoxSize,
  headingOf,
  pickHandle,
  type BoxFace,
  type BoxHandle,
  type ClipBoxLocal,
} from './tools/clipbox';
export { PALETTE } from './palette';
export { reducedMotion } from './motion';
export { solarPosition, skyDirection, utcOffsetHours, type SolarPosition } from './stage/solar';
export { defaultEnvironment, defaultMode, defaultTime, siteLocation } from './stage/envDefaults';
