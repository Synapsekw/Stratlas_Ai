export { interpolatePose } from './pose';
export { parseFlight, type Flight } from './flight';
export {
  imageToRay,
  lensAngles,
  pixelToRay,
  rayToImage,
  rayToPixel,
  type LensAngles,
} from './lens';
export {
  clipWindow,
  clockForVideoTime,
  syncDecision,
  videoTimeForClock,
  type ClipTiming,
  type SyncAction,
  type SyncInput,
} from './clock';
export {
  cameraAngles,
  formatTimecode,
  rotate,
  telemetryAt,
  type CameraAngles,
  type Telemetry,
} from './telemetry';
export { VideoWindow, type VideoWindowProps } from './VideoWindow';

/**
 * Registers video layer adapters with @aio/engine: flight path, drone marker and frustum, and the
 * projector that drapes the current frame on meshes and ground. Owner: stream S6. Phase 0: no-op.
 */
export function registerVideoAdapters(): void {
  /* implemented by stream S6 */
}
