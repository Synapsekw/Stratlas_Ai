import type { PoseSample, Quat, Vec3 } from '@aio/schema';
import { interpolatePose } from './pose';

/** Rotate `v` by unit quaternion `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * (u x v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

const R2D = 180 / Math.PI;

export interface CameraAngles {
  /** Heading of the view, degrees clockwise from north (-Z), 0..360. */
  headingDeg: number;
  /** Camera pitch, degrees; negative looks down. */
  pitchDeg: number;
}

export function cameraAngles(q: Quat): CameraAngles {
  const f = rotate(q, [0, 0, -1]);
  // Looking straight up or down: use the image-up vector for the heading.
  const h = Math.hypot(f[0], f[2]) > 1e-6 ? f : rotate(q, [0, Math.sign(f[1]) || 1, 0]);
  const heading = (Math.atan2(h[0], -h[2]) * R2D + 360) % 360;
  return {
    headingDeg: heading,
    pitchDeg: Math.asin(Math.max(-1, Math.min(1, f[1]))) * R2D,
  };
}

export interface Telemetry extends CameraAngles {
  pose: PoseSample;
  /** Height above `groundY` (the local frame's grade is y = 0). */
  altitudeM: number;
  /** Ground speed estimated from pose deltas over half a second, m/s. */
  speedMps: number;
}

export function telemetryAt(
  samples: readonly PoseSample[],
  tMs: number,
  opts: { groundY?: number; windowMs?: number } = {},
): Telemetry {
  const pose = interpolatePose(samples, tMs);
  const first = samples[0]?.t ?? 0;
  const last = samples[samples.length - 1]?.t ?? 0;
  const half = (opts.windowMs ?? 500) / 2;
  const ta = Math.max(first, tMs - half);
  const tb = Math.min(last, tMs + half);
  let speed = 0;
  if (tb - ta > 1e-6) {
    const a = interpolatePose(samples, ta).pos;
    const b = interpolatePose(samples, tb).pos;
    speed = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / ((tb - ta) / 1000);
  }
  return {
    pose,
    ...cameraAngles(pose.q),
    altitudeM: pose.pos[1] - (opts.groundY ?? 0),
    speedMps: speed,
  };
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** `HH:MM:SS:FF` for a video time in seconds. */
export function formatTimecode(seconds: number, fps = 30): string {
  const rate = Math.round(fps) || 30;
  const frames = Math.max(0, Math.floor(seconds * rate + 1e-6));
  const ff = frames % rate;
  const total = Math.floor(frames / rate);
  return `${p2(Math.floor(total / 3600))}:${p2(Math.floor(total / 60) % 60)}:${p2(total % 60)}:${p2(ff)}`;
}
