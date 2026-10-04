import type { Layer, PoseSample, Vec2 } from '@aio/schema';
import { interpolatePose, orientCamera } from '@aio/video';
import type { DeriveSightings } from '../model/editor';
import { backProject, geomCenter, type RaySurface } from './backproject';

export interface DeriverSources {
  layers: () => readonly Layer[];
  scene: () => RaySurface | null;
  /** Pose samples of a video layer's flight (loaded by the video window or `loadFlightPoses`). */
  flight: (layerId: string) => readonly PoseSample[] | null;
  /** Pixel size of a photo or video frame, once known. Video falls back to 1280 x lens aspect. */
  imageSize: (layerId: string, photoId: string | null) => Vec2 | null;
}

/**
 * ANN-9 automation: when an image or video sighting is added to an issue that has no mesh
 * sighting yet, cast a ray from the camera pose through the shape's centre and add the mesh pin.
 */
export function createDeriver(src: DeriverSources): DeriveSightings {
  return (sighting, issue) => {
    if (issue.sightings.some((s) => s.on === 'mesh')) return [];
    const scene = src.scene();
    if (!scene) return [];
    const layer = src.layers().find((l) => l.id === sighting.layer);
    if (sighting.on === 'image' && layer?.kind === 'photos') {
      const photo = layer.items.find((p) => p.id === sighting.photo);
      const size = src.imageSize(layer.id, sighting.photo);
      const px = geomCenter(sighting.geom);
      if (!photo?.pos || !photo.q || !photo.lens || !size || !px) return [];
      const pin = backProject({ pos: photo.pos, q: photo.q }, photo.lens, px, size, scene);
      return pin ? [pin] : [];
    }
    if (sighting.on === 'video' && layer?.kind === 'video') {
      const key = sighting.track[0];
      const samples = src.flight(layer.id);
      const px = key ? geomCenter(key.geom) : null;
      if (!key || !samples?.length || !px) return [];
      const size = src.imageSize(layer.id, null) ?? [1280, Math.round(1280 / layer.lens.aspect)];
      const log = interpolatePose(samples, layer.offsetMs + key.t * 1000);
      const off = layer.positionOffsetM ?? [0, 0, 0];
      const pose = {
        pos: [log.pos[0] + off[0], log.pos[1] + off[1], log.pos[2] + off[2]] as typeof log.pos,
        q: orientCamera(log.q, layer.orientation),
      };
      const pin = backProject(pose, layer.lens, px, size, scene);
      return pin ? [pin] : [];
    }
    return [];
  };
}
