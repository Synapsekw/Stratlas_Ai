import { describe, expect, it } from 'vitest';
import type { PoseSample, Quat } from '@aio/schema';
import { cameraAngles, formatTimecode, telemetryAt } from './telemetry';

/** Quaternion for Euler(pitch, yaw, 0, 'YXZ'), the DJI path convention. */
function yawPitch(yawRad: number, pitchRad: number): Quat {
  const cy = Math.cos(yawRad / 2);
  const sy = Math.sin(yawRad / 2);
  const cx = Math.cos(pitchRad / 2);
  const sx = Math.sin(pitchRad / 2);
  // q = qy * qx
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}

describe('cameraAngles', () => {
  it('reads heading clockwise from north (-Z) and pitch from the camera quaternion', () => {
    const d2r = Math.PI / 180;
    // DJI path: Euler(gimbal_pitch, -az, 0, 'YXZ'); az 87.95, pitch -25.3
    const a = cameraAngles(yawPitch(-87.95 * d2r, -25.3 * d2r));
    expect(a.headingDeg).toBeCloseTo(87.95, 6);
    expect(a.pitchDeg).toBeCloseTo(-25.3, 6);
    expect(cameraAngles([0, 0, 0, 1]).headingDeg).toBeCloseTo(0, 9);
  });
  it('matches the Al-Zour fixture quaternion', () => {
    const a = cameraAngles([-0.1576, -0.67749, -0.15206, 0.70217]);
    expect(a.headingDeg).toBeCloseTo(87.95, 1);
    expect(a.pitchDeg).toBeCloseTo(-25.3, 1);
  });
});

describe('telemetryAt', () => {
  const id: Quat = [0, 0, 0, 1];
  const s: PoseSample[] = [
    { t: 0, pos: [0, 100, 0], q: id },
    { t: 1000, pos: [10, 100, 0], q: id },
    { t: 2000, pos: [20, 110, 0], q: id },
  ];
  it('gives altitude above the ground height and speed from pose deltas', () => {
    const t = telemetryAt(s, 500, { groundY: 5 });
    expect(t.altitudeM).toBeCloseTo(95, 9);
    expect(t.speedMps).toBeCloseTo(10, 6);
  });
  it('estimates speed at the ends of the log', () => {
    expect(telemetryAt(s, 0).speedMps).toBeCloseTo(10, 6);
    expect(telemetryAt(s, 2000).speedMps).toBeCloseTo(Math.hypot(10, 10), 6);
  });
});

describe('formatTimecode', () => {
  it('formats HH:MM:SS:FF', () => {
    expect(formatTimecode(3.5, 30)).toBe('00:00:03:15');
    expect(formatTimecode(3725.04, 25)).toBe('01:02:05:01');
    expect(formatTimecode(-1, 30)).toBe('00:00:00:00');
  });
});
