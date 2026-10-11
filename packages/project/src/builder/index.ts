// Builder (Release B): new projects, raw import, alignment saves. Node only (file system).
export * from './exif';
export * from './photos';
export * from './templates';
export * from './tiff';
export * from './obj';
export {
  PACKAGE_DIRS,
  captureForDate,
  createProject,
  ensureCapture,
  readManifestFile,
  slug,
  uniqueId,
  updateCapture,
  updateLayers,
  updateManifestFile,
  withManifest,
  writeManifestFile,
  type ManifestChange,
  type ManifestUpdate,
} from './create';
export * from './altitude';
export * from './drawingPlacement';
export {
  DRAWING_ADDED,
  addDrawingPage,
  closeDrawing,
  dxfSource,
  dxfStem,
  importDrawingFile,
  isDrawingFile,
  type ClaimedStems,
  type DrawingImages,
  type DrawingPage,
} from './drawings';
export { modelTextures, mtlTextures, type ModelTextures } from './modelTextures';
export {
  NO_PIPELINE,
  importRawFiles,
  planRawAltitudes,
  type ImageOps,
  type ImportDeps,
  type ImportResult,
  type PipelineJobs,
  type VideoTools,
} from './raw';
export {
  detectProxyEncoder,
  makePoster,
  makeProxy,
  proxyArgs,
  type ProxyEncoder,
  type ProxyOptions,
} from '../import/proxy';
