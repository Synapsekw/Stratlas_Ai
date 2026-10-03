import type { Box3 } from 'three';
import { Sphere, Vector3 } from 'three';

/** Camera position and orbit target, in the local frame (Y up, X east, Z south). */
export interface CameraPose {
  position: Vector3;
  target: Vector3;
}

export type ViewPreset = 'top' | 'north' | 'iso';

const DEG = Math.PI / 180;

/**
 * Distance from the target at which a sphere of `radius` fits the view. Uses the narrower of the
 * vertical and horizontal field of view, so a tall viewport backs off further.
 */
export function fitDistance(radius: number, vfovDeg: number, aspect: number, margin = 1.15) {
  const vfov = vfovDeg * DEG;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(aspect, 1e-6));
  const fov = Math.min(vfov, hfov);
  return (Math.max(radius, 0.01) * margin) / Math.sin(fov / 2);
}

/** Unit vector from the target to the camera for a preset. */
function presetDirection(preset: ViewPreset): Vector3 {
  switch (preset) {
    case 'top':
      // A hair south of straight down, so OrbitControls keeps north (-Z) at the top of the screen.
      return new Vector3(0, 1, 1e-4).normalize();
    case 'north': {
      // Camera north of the target, looking south at the north elevation, 15 degrees above it.
      const alt = 15 * DEG;
      return new Vector3(0, Math.sin(alt), -Math.cos(alt));
    }
    case 'iso':
      // Classic isometric from the south-east: equal east, up and south components.
      return new Vector3(1, 1, 1).normalize();
  }
}

export function poseForPreset(
  preset: ViewPreset,
  sphere: { center: Vector3; radius: number },
  vfovDeg: number,
  aspect: number,
): CameraPose {
  const d = fitDistance(sphere.radius, vfovDeg, aspect);
  const target = sphere.center.clone();
  return { target, position: target.clone().addScaledVector(presetDirection(preset), d) };
}

const _sphere = new Sphere();

/** Fit a box while keeping the current viewing direction. Null when the box is empty. */
export function frameBox(
  box: Box3,
  current: CameraPose,
  vfovDeg: number,
  aspect: number,
  margin = 1.25,
): CameraPose | null {
  if (box.isEmpty()) return null;
  box.getBoundingSphere(_sphere);
  const target = _sphere.center.clone();
  const dir = current.position.clone().sub(current.target);
  if (dir.lengthSq() < 1e-12) dir.set(1, 1, 1);
  dir.normalize();
  const d = fitDistance(_sphere.radius, vfovDeg, aspect, margin);
  return { target, position: target.clone().addScaledVector(dir, d) };
}

/** Pose that looks at a point from the current direction at `distance` (or the current distance). */
export function poseForPoint(point: Vector3, current: CameraPose, distance?: number): CameraPose {
  const dir = current.position.clone().sub(current.target);
  const d = distance ?? dir.length();
  if (dir.lengthSq() < 1e-12) dir.set(1, 1, 1);
  dir.normalize();
  return { target: point.clone(), position: point.clone().addScaledVector(dir, d) };
}

/** Compass heading of the view (camera to target), degrees clockwise from north (-Z). */
export function headingDeg(position: Vector3, target: Vector3): number {
  const dx = target.x - position.x;
  const dz = target.z - position.z;
  const h = Math.atan2(dx, -dz) / DEG;
  return (h + 360) % 360;
}

export function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
