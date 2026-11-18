import { Plane, Vector3, type PerspectiveCamera } from 'three';

export type ToLocal = (E: number, N: number, H: number) => [number, number, number];

/** Project CRS (easting, northing, height) to the local frame (x east, y up, z south). */
export function toLocalFn(origin: readonly [number, number, number]): ToLocal {
  return (E, N, H) => [E - origin[0], H - origin[2], origin[1] - N];
}

const UP = new Vector3();
const DIR = new Vector3();
const RIGHT = new Vector3();
const N = new Vector3();

/**
 * A world plane through the camera that projects to the vertical screen line at `x` (0 left,
 * 1 right); points right of the line are on its positive side.
 */
export function swipePlane(camera: PerspectiveCamera, x: number, out = new Plane()): Plane {
  camera.updateMatrixWorld();
  UP.set(0, 1, 0).applyQuaternion(camera.quaternion);
  RIGHT.set(1, 0, 0).applyQuaternion(camera.quaternion);
  DIR.set(x * 2 - 1, 0, 0.5)
    .unproject(camera)
    .sub(camera.position)
    .normalize();
  N.crossVectors(DIR, UP).normalize();
  if (N.dot(RIGHT) < 0) N.negate();
  return out.setFromNormalAndCoplanarPoint(N, camera.position);
}
