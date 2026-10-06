import type { LensModel, Quat, Vec3 } from '@aio/schema';
import { imageToRay } from './lens';
import { quatRotate } from './orientation';

/** A posed camera: position and orientation in the local frame, and its lens. */
export interface GroundPose {
  pos: Vec3;
  q: Quat;
  lens: LensModel;
}

/**
 * Where the ray through normalised image point (x, y) of a posed camera meets the ground plane
 * `y = groundY` (local frame), or null when it points at or above the horizon or the camera is
 * below the ground. Pure, so main and the renderer can both place what a photo shows.
 */
export function groundPoint(pose: GroundPose, x: number, y: number, groundY = 0): Vec3 | null {
  const h = pose.pos[1] - groundY;
  if (!(h > 0)) return null;
  const d = quatRotate(pose.q, imageToRay(pose.lens, x, y));
  if (!(d[1] < -1e-9)) return null;
  const t = h / -d[1];
  return [pose.pos[0] + d[0] * t, groundY, pose.pos[2] + d[2] * t];
}
