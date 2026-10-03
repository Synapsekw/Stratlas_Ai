import { describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '@aio/schema';
import { KIT_FRAME, mapPoint } from './frames';
import {
  AioFlight,
  aimErrorDeg,
  clipOffsetMs,
  convertKitFlight,
  logSampleTime,
  poseAt,
  type KitFlight,
} from './flight';
import { cameraQuatLookAlong, quatMultiply, sub } from './math';

const s = Math.SQRT1_2;

/** First three samples of HCl flight 101 as delivered in data/flight101.js. */
function slice(): KitFlight {
  return {
    id: '101',
    name: 'Flight 101 · Shell pass 1',
    video_offset: 131.502734,
    duration_s: 384.384,
    segments: ['v101_00.mp4', 'v101_01.mp4'],
    segment_s: 60,
    t: [-15.59, -15.49, -15.38],
    pos: [
      [0.318, 0.094, 4.659],
      [0.316, 0.094, 4.66],
      [0.318, 0.093, 4.66],
    ],
    q: [
      [0.0997, 0.0535, 0.0215, 0.9934],
      [0.0996, 0.0533, 0.0213, 0.9934],
      [0.0996, 0.0534, 0.0215, 0.9934],
    ],
    qd: [
      [-0.6646, -0.0857, 0.7402, 0.0553],
      [-0.6647, -0.0855, 0.7401, 0.0554],
      [-0.6646, -0.0856, 0.7402, 0.0553],
    ],
    servo: [0, 0, 0],
    pois: [],
    fov_h_deg: 114,
    lens: 'ftheta',
  };
}

describe('convertKitFlight', () => {
  it('converts times to ms from the first sample and poses into the local frame', () => {
    const { doc, t0 } = convertKitFlight(slice(), KIT_FRAME, 1_700_632_800_000, 960 / 540);
    expect(t0).toBe(-15.59);
    expect(doc.schema).toBe('aio.flight/1');
    expect(doc.startUtcMs).toBe(1_700_632_800_000);
    expect(doc.lens).toEqual({ model: 'ftheta', hfovDeg: 114, aspect: 1.7778 });
    expect(doc.samples.map((p) => p.t)).toEqual([0, 100, 210]);
    // x = z_kit, y = y_kit, z = -x_kit
    expect(doc.samples[0]?.pos).toEqual([4.659, 0.094, -0.318]);
    const qR: Quat = [0, s, 0, s];
    const want = quatMultiply(qR, [0.0997, 0.0535, 0.0215, 0.9934]);
    const got = doc.samples[0]?.q ?? [0, 0, 0, 0];
    want.forEach((v, i) => {
      expect(Math.abs(v / Math.hypot(...want) - (got[i] ?? 0))).toBeLessThan(1e-5);
    });
    expect(AioFlight.safeParse(doc).success).toBe(true);
  });

  it('maps clip k of a 60 s segmented video onto the flight clock', () => {
    // Video time v of clip k is flight video time k * 60 + v; samples start at t0.
    expect(clipOffsetMs(0, 60, -15.59)).toBe(15_590);
    expect(clipOffsetMs(1, 60, -15.59)).toBe(75_590);
  });

  it('attaches a POI to the first log sample at or after its time, like the kit', () => {
    const t = [-15.59, -15.49, -15.38];
    expect(logSampleTime(t, -15.5)).toBe(-15.49);
    expect(logSampleTime(t, -15.49)).toBe(-15.49);
    expect(logSampleTime(t, 99)).toBe(-15.38);
  });

  it('interpolates a pose between samples', () => {
    const { doc } = convertKitFlight(slice(), KIT_FRAME, 0, 1.7778);
    const p = poseAt(doc, 50);
    expect(p.pos[0]).toBeCloseTo(4.6595, 6);
    expect(p.pos[2]).toBeCloseTo(-0.317, 6);
  });
});

describe('camera aim survives the frame conversion', () => {
  it('a camera that looks at a POI in the kit frame still looks at it in the local frame', () => {
    const cam: Vec3 = [0.19, 1.158, -0.435];
    const target: Vec3 = [0.206, 0.036, -1.212];
    const q = cameraQuatLookAlong(sub(target, cam), [1, 0, 0]);
    const f = slice();
    f.t = [0, 1];
    f.pos = [cam, cam];
    f.q = [q, q];
    f.qd = [q, q];
    f.servo = [0, 0];
    const { doc, t0 } = convertKitFlight(f, KIT_FRAME, 0, 1.7778);
    const err = aimErrorDeg(doc, (0.5 - t0) * 1000, mapPoint(KIT_FRAME, target));
    expect(err).toBeLessThan(0.01);
    // and a wrong mapping (no rotation of the quaternion) would miss by about 90 deg
    expect(
      aimErrorDeg(
        { ...doc, samples: doc.samples.map((p) => ({ ...p, q })) },
        500,
        mapPoint(KIT_FRAME, target),
      ),
    ).toBeGreaterThan(30);
  });
});
