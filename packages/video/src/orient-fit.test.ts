import type { CameraOrientation, LensModel, PoseSample, Quat, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  fitCalibration,
  pairErrorPx,
  projectCalibrated,
  type CalibrationState,
  type LensPair,
  type PoseLookup,
} from './calibrate';
import { NO_ORIENTATION } from './orientation';
import { interpolatePose } from './pose';
import { cameraQuatFromGimbal } from './srt';

/** A deterministic pseudo-random sequence (tests must not flake). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const LENS: LensModel = { model: 'pinhole', hfovDeg: 72.2, aspect: 1.8972 };
const W = 1920;

/** A flight passing a plant: 100 m up, heading drifting, camera 23 degrees down. */
function flight(): PoseSample[] {
  const out: PoseSample[] = [];
  for (let t = 0; t <= 60_000; t += 100) {
    const s = t / 1000;
    out.push({
      t,
      pos: [-200 + 4 * s, 110 + 0.1 * s, 300 - 2 * s],
      q: cameraQuatFromGimbal(10 + 0.8 * s, -23 - 0.05 * s, 0),
    });
  }
  return out;
}
const SAMPLES = flight();
const poseAt: PoseLookup = (ms) => {
  const p = interpolatePose(SAMPLES, ms);
  return { pos: p.pos, q: p.q };
};

/**
 * Pairs as the true camera saw them: model points spread over what the frame shows (ground and
 * tank tops up to 40 m), with the image point from the true calibration plus pixel noise.
 */
function synth(
  truth: CalibrationState,
  frames: number[],
  perFrame: number,
  noisePx: number,
  seed = 7,
  lens: LensModel = LENS,
): LensPair[] {
  const rand = rng(seed);
  const pairs: LensPair[] = [];
  for (const videoMs of frames) {
    const log = poseAt(truth.offsetMs + videoMs);
    let made = 0;
    while (made < perFrame) {
      const world: Vec3 = [
        log.pos[0] + (rand() - 0.5) * 500,
        rand() < 0.5 ? 0 : rand() * 40,
        log.pos[2] - 120 - rand() * 400,
      ];
      const p: LensPair = { image: [0, 0], world, pos: log.pos, q: log.q, videoMs };
      const im = projectCalibrated(p, { ...truth, lens: { ...lens, hfovDeg: truth.lens.hfovDeg } });
      if (!im || im[0] < 0.05 || im[0] > 0.95 || im[1] < 0.05 || im[1] > 0.95) continue;
      const nx = ((rand() - 0.5) * 2 * noisePx) / W;
      const ny = ((rand() - 0.5) * 2 * noisePx * lens.aspect) / W;
      pairs.push({ ...p, image: [im[0] + nx, im[1] + ny] });
      made++;
    }
  }
  return pairs;
}

const BIAS: CameraOrientation = { yawDeg: 1.35, pitchDeg: -8.2, rollDeg: 0.65 };

function expectOrientation(got: CameraOrientation, want: CameraOrientation, tolDeg: number) {
  expect(Math.abs(got.yawDeg - want.yawDeg)).toBeLessThan(tolDeg);
  expect(Math.abs(got.pitchDeg - want.pitchDeg)).toBeLessThan(tolDeg);
  expect(Math.abs(got.rollDeg - want.rollDeg)).toBeLessThan(tolDeg);
}

describe('fitCalibration (orientation bias, position fixed by the log)', () => {
  const start: CalibrationState = { lens: LENS, orientation: NO_ORIENTATION, offsetMs: 0 };

  it('recovers a known bias exactly from three noiseless pairs on one frame', () => {
    const truth: CalibrationState = { ...start, orientation: BIAS };
    const pairs = synth(truth, [12_000], 3, 0);
    const r = fitCalibration(pairs, start, { widthPx: W });
    expectOrientation(r.state.orientation, BIAS, 0.002);
    expect(r.before.rmsPx).toBeGreaterThan(100);
    expect(r.after.rmsPx).toBeLessThan(0.05);
    expect(r.solved).toEqual(['yaw', 'pitch', 'roll']);
  });

  it('recovers the bias within 0.1 degree from six pairs with 1 px picking noise', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const truth: CalibrationState = { ...start, orientation: BIAS };
      const pairs = synth(truth, [8_000], 6, 1, seed);
      const r = fitCalibration(pairs, start, { widthPx: W });
      expectOrientation(r.state.orientation, BIAS, 0.1);
      expect(r.after.rmsPx).toBeLessThan(1.5);
      // leave-one-out errors stay at the noise level
      expect(r.heldOut?.rmsPx ?? 99).toBeLessThan(3);
    }
  });

  it('keeps yaw and pitch within 0.1 degree at 2 px noise (roll is the weakest axis)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const truth: CalibrationState = { ...start, orientation: BIAS };
      const r = fitCalibration(synth(truth, [8_000], 6, 2, seed), start, { widthPx: W });
      expect(Math.abs(r.state.orientation.yawDeg - BIAS.yawDeg)).toBeLessThan(0.1);
      expect(Math.abs(r.state.orientation.pitchDeg - BIAS.pitchDeg)).toBeLessThan(0.1);
      expect(Math.abs(r.state.orientation.rollDeg - BIAS.rollDeg)).toBeLessThan(0.3);
    }
  });

  it('recovers the bias from pairs on several frames of a turning flight', () => {
    const truth: CalibrationState = {
      ...start,
      orientation: { yawDeg: -2.1, pitchDeg: 7.4, rollDeg: -1.2 },
    };
    const pairs = synth(truth, [5_000, 25_000, 45_000], 2, 1, 11);
    const r = fitCalibration(pairs, start, { widthPx: W });
    expectOrientation(r.state.orientation, truth.orientation, 0.1);
  });

  it('can hold roll at its start value and fit yaw and pitch only', () => {
    const truth: CalibrationState = {
      ...start,
      orientation: { yawDeg: 0.8, pitchDeg: -8, rollDeg: 0 },
    };
    const pairs = synth(truth, [20_000], 2, 0);
    const r = fitCalibration(pairs, start, { widthPx: W, roll: false });
    expect(r.solved).toEqual(['yaw', 'pitch']);
    expect(r.state.orientation.rollDeg).toBe(0);
    expectOrientation(r.state.orientation, truth.orientation, 0.01);
  });

  it('refines the field of view together with the bias', () => {
    const truth: CalibrationState = {
      lens: { ...LENS, hfovDeg: 70.4 },
      orientation: BIAS,
      offsetMs: 0,
    };
    const pairs = synth(truth, [15_000], 6, 1, 3);
    const r = fitCalibration(pairs, start, { widthPx: W, fov: true });
    expect(Math.abs(r.state.lens.hfovDeg - 70.4)).toBeLessThan(0.15);
    expectOrientation(r.state.orientation, BIAS, 0.1);
    expect(r.state.lens.aspect).toBe(LENS.aspect);
  });

  it('refines the time offset when the pairs carry video time and the flight is known', () => {
    const truth: CalibrationState = { ...start, orientation: BIAS, offsetMs: 640 };
    // two frames far apart: a time error moves the camera along the path
    const pairs = synth(truth, [10_000, 40_000], 4, 0.5, 5);
    // picked with the old offset: the stored pose is that of the wrong time
    const picked = pairs.map((p) => {
      const log = poseAt(0 + (p.videoMs ?? 0));
      return { ...p, pos: log.pos, q: log.q };
    });
    const r = fitCalibration(picked, start, { widthPx: W, time: true, poseAt });
    expect(Math.abs(r.state.offsetMs - 640)).toBeLessThan(40);
    expectOrientation(r.state.orientation, BIAS, 0.1);
    expect(() => fitCalibration(picked, start, { time: true })).toThrow(/flight/);
  });

  it('recovers an altitude datum error with the bias, which a turn alone cannot explain', () => {
    // the Al-Zour case: the log puts the camera 40 m too low, the gimbal is off by about a degree
    const truth: CalibrationState = {
      ...start,
      orientation: { yawDeg: -1, pitchDeg: -0.9, rollDeg: -0.6 },
      positionOffset: [9, 40, 4],
    };
    const pairs = synth(truth, [10_000], 10, 0.5, 21);
    const turnOnly = fitCalibration(pairs, start, { widthPx: W });
    expect(turnOnly.after.rmsPx).toBeGreaterThan(5);
    const r = fitCalibration(pairs, start, { widthPx: W, position: true });
    expect(r.solved).toEqual(['yaw', 'pitch', 'roll', 'x', 'y', 'z']);
    expectOrientation(r.state.orientation, truth.orientation, 0.1);
    const d = r.state.positionOffset ?? [0, 0, 0];
    expect(Math.abs(d[1] - 40)).toBeLessThan(1);
    expect(Math.hypot(d[0] - 9, d[2] - 4)).toBeLessThan(3);
    expect(r.after.rmsPx).toBeLessThan(1);
  });

  it('keeps a saved position offset when only the orientation is fitted', () => {
    const truth: CalibrationState = {
      ...start,
      orientation: BIAS,
      positionOffset: [0, 25, 0],
    };
    const pairs = synth(truth, [10_000], 4, 0, 4);
    const r = fitCalibration(pairs, { ...start, positionOffset: [0, 25, 0] }, { widthPx: W });
    expect(r.state.positionOffset).toEqual([0, 25, 0]);
    expectOrientation(r.state.orientation, BIAS, 0.01);
  });

  it('works with an f-theta lens', () => {
    const fish: LensModel = { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 };
    const s0: CalibrationState = { lens: fish, orientation: NO_ORIENTATION, offsetMs: 0 };
    const truth: CalibrationState = { ...s0, orientation: { yawDeg: 3, pitchDeg: -6, rollDeg: 1 } };
    const pairs = synth(truth, [30_000], 5, 0, 9, fish);
    const r = fitCalibration(pairs, s0, { widthPx: W });
    expectOrientation(r.state.orientation, truth.orientation, 0.01);
  });

  it('says how many pairs it needs', () => {
    const truth: CalibrationState = { ...start, orientation: BIAS };
    const one = synth(truth, [12_000], 1, 0);
    expect(() => fitCalibration(one, start)).toThrow(/at least 2/);
    const two = synth(truth, [12_000], 2, 0);
    expect(() => fitCalibration(two, start, { fov: true, time: true, poseAt })).toThrow(
      /at least 3/,
    );
    expect(() => fitCalibration(two, start, { orientation: false })).toThrow(/at least one/);
  });

  it('reports the error of a pair under a calibration in pixels', () => {
    const truth: CalibrationState = { ...start, orientation: BIAS };
    const [p] = synth(truth, [12_000], 1, 0);
    if (!p) throw new Error('no pair');
    expect(pairErrorPx(p, truth, W)).toBeCloseTo(0, 6);
    // 8.2 degrees of pitch on a 72 degree lens is well over a hundred pixels
    expect(pairErrorPx(p, start, W)).toBeGreaterThan(150);
    const q: Quat = p.q;
    expect(q).toHaveLength(4);
  });
});
