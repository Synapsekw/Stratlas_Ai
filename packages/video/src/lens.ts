import type { LensModel, Vec3 } from '@aio/schema';

/**
 * Camera lens models. Camera frame: looks down local -Z, +X image right, +Y image up (three.js).
 * Image coordinates `x, y` are normalised to [0, 1] with a top-left origin (pixel convention);
 * pixels use the same orientation scaled by the frame size.
 *
 * - `pinhole`: rectilinear, `hfovDeg` across the frame width.
 * - `ftheta`: equidistant fisheye, image radius `r = f * theta` (optionally
 *   `theta * (1 + k0 theta^2 + k1 theta^4 + ...)`), `hfovDeg` across the frame width, square pixels.
 */

const D2R = Math.PI / 180;

/** Distortion polynomial r(theta) for an f-theta lens. */
function fthetaR(theta: number, k: readonly number[] | undefined): number {
  if (!k?.length) return theta;
  let s = 1;
  let t2n = 1;
  const t2 = theta * theta;
  for (const c of k) {
    t2n *= t2;
    s += c * t2n;
  }
  return theta * s;
}

/** Inverse of `fthetaR` by Newton iteration (monotonic over the useful range). */
function fthetaTheta(r: number, k: readonly number[] | undefined): number {
  if (!k?.length) return r;
  let th = r;
  for (let i = 0; i < 30; i++) {
    const h = 1e-7;
    const f = fthetaR(th, k) - r;
    const d = (fthetaR(th + h, k) - fthetaR(th - h, k)) / (2 * h);
    if (Math.abs(d) < 1e-12) break;
    const step = f / d;
    th -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return th;
}

export interface LensAngles {
  /** Horizontal field of view across the frame, radians. */
  hfov: number;
  /** Vertical field of view across the frame, radians. */
  vfov: number;
}

export function lensAngles(lens: LensModel): LensAngles {
  const half = (lens.hfovDeg * D2R) / 2;
  if (lens.model === 'pinhole') {
    return { hfov: 2 * half, vfov: 2 * Math.atan(Math.tan(half) / lens.aspect) };
  }
  const R = fthetaR(half, lens.k);
  return { hfov: 2 * half, vfov: 2 * fthetaTheta(R / lens.aspect, lens.k) };
}

/** Unit ray in the camera frame through normalised image point (x, y). */
export function imageToRay(lens: LensModel, x: number, y: number): Vec3 {
  const nx = 2 * x - 1;
  const ny = 1 - 2 * y;
  const half = (lens.hfovDeg * D2R) / 2;
  if (lens.model === 'pinhole') {
    const tH = Math.tan(half);
    const v: Vec3 = [nx * tH, (ny * tH) / lens.aspect, -1];
    const n = Math.hypot(...v);
    return [v[0] / n, v[1] / n, v[2] / n];
  }
  const nyS = ny / lens.aspect;
  const rho = Math.hypot(nx, nyS);
  if (rho < 1e-15) return [0, 0, -1];
  const theta = fthetaTheta(rho * fthetaR(half, lens.k), lens.k);
  const psi = Math.atan2(nyS, nx);
  const s = Math.sin(theta);
  return [s * Math.cos(psi), s * Math.sin(psi), -Math.cos(theta)];
}

/**
 * Normalised image point of a camera-frame direction, or null when the lens cannot see it (behind
 * a pinhole camera). Points outside [0, 1] are outside the frame.
 */
export function rayToImage(lens: LensModel, d: Vec3): [number, number] | null {
  const half = (lens.hfovDeg * D2R) / 2;
  if (lens.model === 'pinhole') {
    if (!(d[2] < -1e-12)) return null;
    const tH = Math.tan(half);
    const nx = d[0] / -d[2] / tH;
    const ny = (d[1] / -d[2] / tH) * lens.aspect;
    return [(nx + 1) / 2, (1 - ny) / 2];
  }
  const L = Math.hypot(...d);
  if (!(L > 0)) return null;
  const theta = Math.acos(Math.min(1, Math.max(-1, -d[2] / L)));
  const psi = Math.atan2(d[1], d[0]);
  const rho = fthetaR(theta, lens.k) / fthetaR(half, lens.k);
  const nx = rho * Math.cos(psi);
  const ny = rho * Math.sin(psi) * lens.aspect;
  return [(nx + 1) / 2, (1 - ny) / 2];
}

export function pixelToRay(
  lens: LensModel,
  px: number,
  py: number,
  width: number,
  height: number,
): Vec3 {
  return imageToRay(lens, px / width, py / height);
}

export function rayToPixel(
  lens: LensModel,
  d: Vec3,
  width: number,
  height: number,
): [number, number] | null {
  const p = rayToImage(lens, d);
  return p ? [p[0] * width, p[1] * height] : null;
}
