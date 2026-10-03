import { describe, expect, it } from 'vitest';
import { parseFlight } from './flight';
import { kitClipToFlight } from './kit';
import { cameraAngles, rotate } from './telemetry';

// First two samples of docs/design/assets/hcl/clip_f110_external_pose.json (tank frame).
const hcl = {
  clip: 'clip_f110_external.mp4',
  frame: 'Tank model frame = tank.glb frame: X plant north, Y up, Z plant east',
  lens: { model: 'ftheta', fov_h_deg: 114, image_aspect: '16:9' },
  samples: [
    {
      t: 0.0,
      pos: [2.92, 10.404, -1.904],
      q: [-0.2244, 0.7838, 0.3529, 0.4591],
      q_drone: [0.2466, -0.0111, 0.9639, -0.0993],
      servo_deg: 38.1,
    },
    {
      t: 0.1,
      pos: [2.902, 10.421, -1.936],
      q: [-0.2194, 0.7859, 0.3564, 0.4551],
      q_drone: [0.2527, -0.0154, 0.9624, -0.0988],
      servo_deg: 38.1,
    },
  ],
};

// First sample of docs/design/assets/alzour/clip_dji0789_tanks_path.json (already the local frame).
const alz = {
  recorded_utc: '2023-02-21T15:11:11.000000Z',
  clip_start_in_source_s: 5,
  clip_resolution: [1280, 720],
  lens: { camera: 'DJI Mavic 3 Cine', hfov_deg: 83.0, source_aspect: 1.8962962962962964 },
  samples: [
    {
      t: 0.0,
      pos: [-205.5, 103.87, -6.24],
      q: [-0.1576, -0.67749, -0.15206, 0.70217],
      az_deg: 87.95,
      gimbal_pitch_deg: -25.3,
    },
  ],
};

describe('kitClipToFlight (MANIFEST fixtures -> aio.flight/1)', () => {
  it('converts the HCl f-theta clip from the tank frame into the local frame', () => {
    const f = parseFlight(
      kitClipToFlight(hcl, { startUtcMs: 1700000000000, frame: 'tank-north-x' }),
    );
    expect(f.lens).toEqual({ model: 'ftheta', hfovDeg: 114, aspect: 16 / 9 });
    expect(f.samples.map((s) => s.t)).toEqual([0, 100]);
    // tank (north, up, east) = (2.92, 10.404, -1.904) -> local (east, up, south)
    const p = f.samples[0]?.pos ?? [0, 0, 0];
    expect(p[0]).toBeCloseTo(-1.904, 9);
    expect(p[1]).toBeCloseTo(10.404, 9);
    expect(p[2]).toBeCloseTo(-2.92, 9);
    // the view direction turns with the positions
    const dTank = rotate(hcl.samples[0]?.q as [number, number, number, number], [0, 0, -1]);
    const dLocal = rotate(f.samples[0]?.q ?? [0, 0, 0, 1], [0, 0, -1]);
    expect(dLocal[0]).toBeCloseTo(dTank[2], 3);
    expect(dLocal[1]).toBeCloseTo(dTank[1], 3);
    expect(dLocal[2]).toBeCloseTo(-dTank[0], 3);
  });

  it('keeps the Al-Zour pinhole clip in place and takes the start time from the recording', () => {
    const f = parseFlight(kitClipToFlight(alz, { frame: 'local' }));
    expect(f.startUtcMs).toBe(Date.parse('2023-02-21T15:11:11Z') + 5000);
    expect(f.lens).toEqual({ model: 'pinhole', hfovDeg: 83, aspect: 1280 / 720 });
    expect(f.samples[0]?.pos).toEqual([-205.5, 103.87, -6.24]);
    const a = cameraAngles(f.samples[0]?.q ?? [0, 0, 0, 1]);
    expect(a.headingDeg).toBeCloseTo(87.95, 1);
    expect(a.pitchDeg).toBeCloseTo(-25.3, 1);
  });
});
