import type { LensModel, Quat } from '@aio/schema';

/* Camera orientation and lens helpers shared by photo and video import. */

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const axisAngle = (axis: 0 | 1 | 2, deg: number): Quat => {
  const h = (deg * Math.PI) / 360;
  const q: Quat = [0, 0, 0, Math.cos(h)];
  q[axis] = Math.sin(h);
  return q;
};

/**
 * three.js camera quaternion (looks down -Z, +Y up in the image) in the local frame (x east, y up,
 * z south) from a heading clockwise from grid north, pitch (negative looks down) and roll
 * (positive drops the image right side).
 */
export function cameraQuatFromGimbal(yawDeg: number, pitchDeg: number, rollDeg: number): Quat {
  return quatMul(quatMul(axisAngle(1, -yawDeg), axisAngle(0, pitchDeg)), axisAngle(2, -rollDeg));
}

/**
 * Pinhole lens from a 35 mm equivalent focal length. DJI quotes the equivalent for the sensor's
 * diagonal (43.27 mm); video modes use the full sensor width, so the horizontal field of view is
 * taken across the width of a `sensorAspect` frame and the vertical one follows `aspect`.
 */
export function lensFromFocal35(focal35: number, aspect: number, sensorAspect = 4 / 3): LensModel {
  const width = (43.2666 * sensorAspect) / Math.hypot(sensorAspect, 1);
  const hfovDeg = (2 * Math.atan(width / (2 * focal35)) * 180) / Math.PI;
  return {
    model: 'pinhole',
    hfovDeg: Math.round(hfovDeg * 100) / 100,
    aspect: Math.round(aspect * 10000) / 10000,
  };
}
