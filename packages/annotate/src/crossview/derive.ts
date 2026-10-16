import { movedSighting } from '../model/dateFrame';
import type { DeriveSightings } from '../model/editor';
import { backProject, geomCenter, type RaySurface } from './backproject';
import { sightingCamera, type CameraSources } from './camera';

export interface DeriverSources extends CameraSources {
  scene: () => RaySurface | null;
}

/**
 * ANN-9 automation: when an image or video sighting is added to an issue that has no mesh
 * sighting yet, cast a ray from the camera pose through the shape's centre and add the mesh pin.
 * The pin names the sighting it came from (`from`): that marks it as automatic, so placing the
 * finding as an area on that layer replaces it (model/placed.ts). The camera and the surface are
 * where they are drawn (`shiftOf`); the pin is saved in its surface date's own frame.
 */
export function createDeriver(src: DeriverSources): DeriveSightings {
  return (sighting, issue) => {
    if (issue.sightings.some((s) => s.on === 'mesh')) return [];
    const scene = src.scene();
    if (!scene) return [];
    const cam = sightingCamera(sighting, src);
    const px = cam ? geomCenter(cam.geom) : null;
    if (!cam || !px) return [];
    const hit = backProject(cam.pose, cam.lens, px, cam.size, scene);
    if (!hit) return [];
    const pin = movedSighting(hit, src.shiftOf?.(hit.layer) ?? null, -1);
    const at = issue.sightings.lastIndexOf(sighting);
    return [{ ...pin, from: { sighting: at >= 0 ? at : issue.sightings.length - 1 } }];
  };
}
