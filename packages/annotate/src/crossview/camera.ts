import { clipCamera, clipKeys, clipPoseAt, correctedPhoto, photoCorrection } from '@aio/geo';
import {
  shiftedDirectionKeys,
  shiftedLayer,
  shiftLocal,
  type FrameGeom,
  type ImageGeom,
  type Layer,
  type LensModel,
  type OrientationFile,
  type PoseSample,
  type Sighting,
  type Vec2,
} from '@aio/schema';
import type { ShiftOf } from '../model/dateFrame';
import type { CameraPose } from './lens';

/** Where the camera of a photo or a video frame comes from. */
export interface CameraSources {
  layers: () => readonly Layer[];
  /** Pose samples of a video layer's flight (loaded by the video window or `loadFlightPoses`). */
  flight: (layerId: string) => readonly PoseSample[] | null;
  /** Pixel size of a photo or video frame, once known. Video falls back to 1280 x lens aspect. */
  imageSize: (layerId: string, photoId: string | null) => Vec2 | null;
  /** The project's orientation.json (hand-set camera directions), if any. */
  orientation?: () => OrientationFile | null;
  /** Date shifts of the layers: a lined-up date's cameras sit where its layers are drawn. */
  shiftOf?: ShiftOf;
}

/** The camera an image or video sighting was seen with, and its shape in that image. */
export interface SightingCamera {
  pose: CameraPose;
  lens: LensModel;
  size: Vec2;
  /** The shape in image pixels (for video: at the first keyframe). */
  geom: ImageGeom | FrameGeom;
}

/** Null for other sightings, an unposed photo, a photo of unknown size or a flight not loaded. */
export function sightingCamera(s: Sighting, src: CameraSources): SightingCamera | null {
  const found = src.layers().find((l) => l.id === s.layer);
  const shift = found ? (src.shiftOf?.(found.id) ?? null) : null;
  // the video offset carries the shift; a photo is shifted after its hand correction
  const layer = found && shift ? shiftedLayer(found, shift) : found;
  if (s.on === 'image' && layer?.kind === 'photos') {
    const item = layer.items.find((p) => p.id === s.photo);
    const photo = item
      ? correctedPhoto(item, photoCorrection(src.orientation?.(), layer.id, item.id))
      : undefined;
    const size = src.imageSize(layer.id, s.photo);
    if (!photo?.pos || !photo.q || !photo.lens || !size) return null;
    const pos = shiftLocal(photo.pos, shift);
    return { pose: { pos, q: photo.q }, lens: photo.lens, size, geom: s.geom };
  }
  if (s.on === 'video' && layer?.kind === 'video') {
    const key = s.track[0];
    const samples = src.flight(layer.id);
    if (!key || !samples?.length) return null;
    const size: Vec2 = src.imageSize(layer.id, null) ?? [
      1280,
      Math.round(1280 / layer.lens.aspect),
    ];
    // the camera as every view draws it: direction keyframes, else the log with its bias
    const keys = shiftedDirectionKeys(clipKeys(src.orientation?.(), layer.id), shift);
    const at = clipPoseAt(samples, layer.offsetMs + key.t * 1000, clipCamera(layer, keys));
    return { pose: { pos: at.pos, q: at.q }, lens: layer.lens, size, geom: key.geom };
  }
  return null;
}
