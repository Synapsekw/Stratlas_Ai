import type { LensModel, Quat, Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { fitLens, projectPair, type LensPair } from './calibrate';
import { cameraQuatFromGimbal } from './srt';

const POS: Vec3 = [0, 120, 0];
const WORLD: Vec3[] = [
  [40, 0, -300],
  [-90, 0, -250],
  [10, 30, -150],
  [120, 0, -420],
  [-30, 10, -500],
];

/** Pairs as a camera with `trueLens` and orientation `qTrue` saw them, posed at `qLog`. */
function pairs(trueLens: LensModel, qTrue: Quat, qLog: Quat): LensPair[] {
  return WORLD.map((world) => {
    const image = projectPair({ image: [0, 0], world, pos: POS, q: qTrue }, trueLens);
    if (!image) throw new Error('point not in view');
    return { image, world, pos: POS, q: qLog };
  });
}

describe('fitLens', () => {
  it('recovers the horizontal field of view from point pairs', () => {
    const q = cameraQuatFromGimbal(0, -25, 0);
    const truth: LensModel = { model: 'pinhole', hfovDeg: 71.6, aspect: 16 / 9 };
    const start: LensModel = { ...truth, hfovDeg: 79.35 };
    const r = fitLens(pairs(truth, q, q), start, { widthPx: 1920, solveRotation: false });
    expect(r.lens.hfovDeg).toBeCloseTo(71.6, 3);
    expect(r.lens.aspect).toBe(start.aspect);
    expect(r.before.rmsPx).toBeGreaterThan(20);
    expect(r.after.rmsPx).toBeLessThan(0.01);
  });

  it('absorbs a small pose error in the camera angles but keeps them out of the lens', () => {
    const qTrue = cameraQuatFromGimbal(3, -27, 0.5);
    const qLog = cameraQuatFromGimbal(0, -25, 0);
    const truth: LensModel = { model: 'pinhole', hfovDeg: 71.6, aspect: 16 / 9 };
    const r = fitLens(pairs(truth, qTrue, qLog), { ...truth, hfovDeg: 83 }, { widthPx: 1920 });
    expect(r.lens.hfovDeg).toBeCloseTo(71.6, 2);
    expect(Math.abs(r.rotationDeg[0])).toBeGreaterThan(1);
    expect(r.after.rmsPx).toBeLessThan(0.05);
    expect(r.after.residualsPx).toHaveLength(WORLD.length);
  });

  it('needs at least two pairs', () => {
    const q = cameraQuatFromGimbal(0, -25, 0);
    const lens: LensModel = { model: 'pinhole', hfovDeg: 70, aspect: 1.5 };
    expect(() => fitLens(pairs(lens, q, q).slice(0, 1), lens)).toThrow(/two/i);
  });
});
