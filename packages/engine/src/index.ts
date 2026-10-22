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
export { releaseParkedStage } from './stage/parking';
export {
  FAR_M,
  configureEngine,
  engineConfig,
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
export {
  MarkerLayer,
  markersHit,
  sceneMarkerView,
  type MarkerLayerOptions,
  type MarkerMember,
  type MarkerSite,
  type MarkerView,
} from './adapters/markers';
export { PANO_SPHERE_R, panoSphereMaterial, type PanoSphereMaterial } from './adapters/panoSphere';
export {
  FULL_SPHERE,
  PANO_FOV,
  azElToDir,
  coverageFromImage,
  dragLook,
  imageCentreDeg,
  itemCoverage,
  panoMarkerStatus,
  panoOpenable,
  hasPos,
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
export { componentOf, nodeById, nodeId } from './adapters/model';
export {
  composePlacement,
  createPlaceGizmo,
  decomposePlacement,
  basisShape,
  placeOnBasis,
  placementOnBasis,
  splitPlacement,
  type GizmoMode,
  type PlaceGizmo,
  type PlaceGizmoHandle,
  type Placement as ModelPlacement,
} from './stage/placeGizmo';
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
export {
  MAX_LASSO_VERTICES,
  PointSelectTool,
  rectPolygon,
  simplifyPath,
  type PointSelection,
  type SelectShape,
} from './tools/pcselect';
export { PolygonClickTool } from './tools/pcpolygon';
export { PALETTE } from './palette';
export { reducedMotion } from './motion';
export { layerBox } from './stage/layerBox';
export { solarPosition, skyDirection, utcOffsetHours, type SolarPosition } from './stage/solar';
export { defaultEnvironment, defaultMode, defaultTime, siteLocation } from './stage/envDefaults';
