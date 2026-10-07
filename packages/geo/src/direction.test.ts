import type { DirectionKey, OrientationFile, PoseSample, Quat, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { cameraQuatFromGimbal } from './camera';
import {
  aimAt,
  biasedQuat,
  clipCamera,
  clipKeys,
  clipPoseAt,
  directionAt,
  directionContext,
  directionFromQuat,
  type DirectionContext,
} from './direction';

const gap = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

function expectDir(
  q: Quat | null,
  yaw: number,
  pitch: number,
  roll: number | null = 0,
  tol = 1e-6,
) {
  expect(q).not.toBeNull();
  const d = directionFromQuat(q ?? [0, 0, 0, 1]);
  expect(gap(d.yaw, yaw)).toBeLessThan(tol);
  expect(Math.abs(d.pitch - pitch)).toBeLessThan(tol);
  if (roll !== null) expect(gap(d.roll, roll)).toBeLessThan(tol);
}

const key = (t: number, yaw: number, extra: Partial<DirectionKey> = {}): DirectionKey => ({
  t,
  yaw,
  pitch: -30,
  roll: 0,
  fill: 'smooth',
  ...extra,
});

/** Hovering at 40 m over the origin: no track. */
const still: DirectionContext = { positionAt: () => [0, 40, 0], trackHeadingAt: () => null };

/** 10 s east at 5 m/s, then north, 40 m up; 50 Hz samples, measured gimbal heading 90. */
function flight(): PoseSample[] {
  const out: PoseSample[] = [];
  for (let t = 0; t <= 30_000; t += 20) {
    const s = t / 1000;
    const pos: Vec3 = s <= 10 ? [s * 5, 40, 0] : [50, 40, -(s - 10) * 5];
    out.push({
      t,
      pos,
      q: cameraQuatFromGimbal(90, -30, 0),
      gimbal: { yaw: 90, pitch: -30, roll: 0 },
    });
  }
  return out;
}

describe('directionFromQuat', () => {
  it('inverts cameraQuatFromGimbal', () => {
    for (const [y, p, r] of [
      [0, -30, 0],
      [90, -90 + 1e-3, 0],
      [181, 10, 5],
      [359.5, -60, -12],
      [270, 0, 179],
    ] as const) {
      const d = directionFromQuat(cameraQuatFromGimbal(y, p, r));
      expect(gap(d.yaw, y)).toBeLessThan(1e-6);
      expect(d.pitch).toBeCloseTo(p, 6);
      expect(gap(d.roll, r)).toBeLessThan(1e-6);
    }
  });
});

describe('directionAt', () => {
  it('has nothing without keyframes', () => {
    expect(directionAt([], 0, still)).toBeNull();
  });

  it('smooth: turns at an even rate between keyframes, held before and after', () => {
    expectDir(directionAt([key(1000, 10), key(3000, 50)], 2000, still), 30, -30, 0, 1e-6);
    expectDir(directionAt([key(1000, 10), key(3000, 50)], 1500, still), 20, -30, 0, 1e-6);
    // with pitch and roll turning too the great-circle midpoint is close to the mean angles
    const keys = [key(1000, 10, { pitch: -20 }), key(3000, 50, { pitch: -40, roll: 4 })];
    expectDir(directionAt(keys, 2000, still), 30, -30, null, 1);
    expectDir(directionAt(keys, 1000, still), 10, -20);
    expectDir(directionAt(keys, 0, still), 10, -20);
    expectDir(directionAt(keys, 3000, still), 50, -40, 4);
    expectDir(directionAt(keys, 60_000, still), 50, -40, 4);
  });

  it('smooth: takes the short way across north and across south', () => {
    expectDir(directionAt([key(0, 350), key(1000, 10)], 500, still), 0, -30, 0, 1e-3);
    // across +-180: 170 to -170 passes 180, not 0
    expectDir(directionAt([key(0, 170), key(1000, -170)], 500, still), 180, -30, 0, 1e-3);
    expectDir(directionAt([key(0, -170), key(1000, 170)], 250, still), 185, -30, 0, 1e-3);
  });

  it('turns smoothly for a fill this build does not know', () => {
    const keys = [key(0, 0, { fill: 'measured' }), key(1000, 40)];
    expectDir(directionAt(keys, 500, still), 20, -30, 0, 1e-3);
  });

  it('track: keeps the offset from the flight track and eases it between keyframes', () => {
    const samples = flight();
    const ctx = directionContext(samples, { videoStartMs: 0 });
    // the track heads east (90) for the first 10 s
    const keys = [
      key(2000, 120, { fill: 'track', pitch: -20 }),
      key(6000, 130, { fill: 'track', pitch: -40 }),
    ];
    expectDir(directionAt(keys, 4000, ctx), 125, -30, 0, 0.01);
    // before the first keyframe its offset holds
    expectDir(directionAt(keys, 500, ctx), 120, -20, 0, 0.01);
    // after the last one the offset follows the turn north (heading 0): 0 + 40
    expectDir(directionAt(keys, 25_000, ctx), 40, -40, 0, 0.01);
  });

  it('track: offsets across north interpolate the short way', () => {
    const ctx: DirectionContext = { positionAt: () => [0, 40, 0], trackHeadingAt: () => 0 };
    const keys = [key(0, 350, { fill: 'track' }), key(1000, 10, { fill: 'track' })];
    expectDir(directionAt(keys, 500, ctx), 0, -30, 0, 1e-3);
  });

  it('track: without a track (hover) it turns smoothly', () => {
    const keys = [key(0, 0, { fill: 'track' }), key(1000, 40)];
    expectDir(directionAt(keys, 500, still), 20, -30, 0, 1e-3);
  });

  it('lookAt: aims at the target from where the drone is, blending at the keyframes', () => {
    const samples = flight();
    const ctx = directionContext(samples, { videoStartMs: 0 });
    const target: Vec3 = [25, 0, -30];
    const keys = [key(1000, 0, { fill: 'lookAt', target }), key(9000, 200, { pitch: -10 })];
    // mid-segment: exactly at the target, level horizon
    const at = (ms: number) => aimAt(ctx.positionAt(ms), target);
    for (const ms of [2000, 5000, 8000])
      expectDir(directionAt(keys, ms, ctx), at(ms).yaw, at(ms).pitch, 0, 1e-6);
    // on the keyframes, the keyframes themselves
    expectDir(directionAt(keys, 1000, ctx), 0, -30, 0, 1e-6);
    expectDir(directionAt(keys, 9000, ctx), 200, -10, 0, 1e-6);
    // half way through the blend: neither
    const d = directionFromQuat(directionAt(keys, 1250, ctx) ?? [0, 0, 0, 1]);
    expect(gap(d.yaw, 0)).toBeGreaterThan(1);
    expect(gap(d.yaw, at(1250).yaw)).toBeGreaterThan(1);
    // after the last keyframe it holds (that keyframe is smooth)
    expectDir(directionAt(keys, 20_000, ctx), 200, -10, 0, 1e-6);
  });

  it('lookAt: a last look-at keyframe keeps aiming after it', () => {
    const samples = flight();
    const ctx = directionContext(samples, { videoStartMs: 0 });
    const target: Vec3 = [50, 0, -50];
    const keys = [key(0, 10), key(1000, 0, { fill: 'lookAt', target })];
    const a = aimAt(ctx.positionAt(5000), target);
    expectDir(directionAt(keys, 5000, ctx), a.yaw, a.pitch, 0, 1e-6);
  });
});

describe('clipPoseAt', () => {
  const samples = flight();
  const layer = {
    flight: { src: { path: 'f.json' }, startUtcMs: 1_000_000 },
    offsetMs: 2000,
    orientation: { yawDeg: 10, pitchDeg: 0, rollDeg: 0 },
    positionOffsetM: [0, -5, 0] as Vec3,
  };

  it('without keyframes: the gimbal orientation turned by the calibration bias', () => {
    const p = clipPoseAt(samples, 4000, clipCamera(layer));
    expect(p.source).toBe('log');
    const want = biasedQuat(cameraQuatFromGimbal(90, -30, 0), layer.orientation);
    p.q.forEach((v, i) => {
      expect(v).toBeCloseTo(want[i] ?? 0, 12);
    });
    // a camera-frame yaw on a camera looking 30 degrees down turns the view left and tilts it
    expect(directionFromQuat(p.q).yaw).toBeLessThan(90);
    expect(p.pos).toEqual([20, 35, 0]);
  });

  it('with keyframes: absolute, the bias left out, the position offset kept, clip time used', () => {
    const cam = clipCamera(layer, [key(0, 100), key(4000, 140)]);
    expect(cam.videoStartMs).toBe(2000);
    // flight time 4000 is clip time 2000: half way
    const p = clipPoseAt(samples, 4000, cam);
    expect(p.source).toBe('keys');
    expectDir(p.q, 120, -30, 0, 1e-3);
    expect(p.pos).toEqual([20, 35, 0]);
    expect(p.log.pos).toEqual([20, 40, 0]);
  });

  it('takes the keyframes from orientation.json; none or empty is the log', () => {
    const file: OrientationFile = {
      schema: 'aio.orientation/1',
      clips: { c1: { keys: [key(0, 200)] }, c2: { keys: [] } },
      photos: {},
    };
    expectDir(clipPoseAt(samples, 0, clipCamera(layer, clipKeys(file, 'c1'))).q, 200, -30);
    expect(clipKeys(file, 'c2')).toBeNull();
    expect(clipKeys(null, 'c1')).toBeNull();
    expect(clipPoseAt(samples, 0, clipCamera(layer, null)).source).toBe('log');
    // another flight file start shifts video time 0
    expect(clipCamera(layer, null, 999_000).videoStartMs).toBe(3000);
  });
});
