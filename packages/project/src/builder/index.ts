// Builder (Release B): new projects, raw import, alignment saves. Node only (file system).
export * from './exif';
export * from './photos';
export * from './templates';
export * from './tiff';
export * from './obj';
export * from './folders';
export {
  PACKAGE_DIRS,
  captureForDate,
  createProject,
  ensureCapture,
  readManifestFile,
  removeCapture,
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
  dxfClash,
  dxfSource,
  dxfStem,
  importDrawingFile,
  isDrawingFile,
  type ClaimedStems,
  type DrawingImages,
  type DrawingPage,
} from './drawings';
export { modelTextures, mtlTextures, type ModelTextures } from './modelTextures';
export { readTiffHeaderFile } from './tiffFile';
export {
  NO_PIPELINE,
  importDay,
  importRawFiles,
  isImportableExtension,
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
export {
  CANCELLED_BEFORE,
  QUIT_REASON,
  WALK_CANCELLED,
  WALK_JSON_MAX_BYTES,
  importWalk,
  listWalks,
  parseWalk,
  sortWalks,
  sweepStaging,
  walkIdFor,
  type WalkCopyRequest,
  type WalkImportOptions,
  type WalkImportResult,
  type WalkTools,
} from './walks';
export {
  classifyWalkSource,
  insta360Name,
  isProxyName,
  isWalkFile,
  proxyOwner,
  type WalkSourceKind,
  type WalkTrack,
} from './walkSource';
export {
  WALK_DEFAULTS,
  checkFfmpeg,
  equirectCopyArgs,
  ffmpegMissingMessage,
  hasV360,
  makeWalkCopy,
  progressSeconds,
  runFfmpeg,
  stitchArgs,
  v360Filter,
  walkSize,
  type FfmpegCheck,
  type FrameSize,
  type StitchOptions,
  type WalkCopy,
  type WalkCopyOptions,
} from '../import/stitch';
