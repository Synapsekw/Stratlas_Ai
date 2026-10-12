import type { PoseSample, WalkCalibration } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  dist,
  lastT,
  loadOrientationRows,
  loadRaw,
  noDrawings,
  pinAtTruth,
} from '../__fixtures__/walk';
import { fitWalk } from './fit';
import { angleDiff, rotateVec } from './horizontal';
import { walkPathPoints, walkPoseSamples } from './pose';

const raw = loadRaw('synthetic');
const broken = loadRaw('broken');
const rows = loadOrientationRows();
const end = lastT(raw);
const cal = (yawOffsetDeg = 0): WalkCalibration => ({
  pins: [pinAtTruth(raw, 4), pinAtTruth(raw, end)],
  yawOffsetDeg,
  heightM: 1.7,
  quality: 'good',
});
const fitFor = (c: WalkCalibration) => fitWalk(raw, c, noDrawings, end);
/** The heading (a Ry angle) of a sample's forward vector. */
const yawOf = (s: PoseSample) => {
  const f = rotateVec(s.q, [0, 0, -1]);
  return Math.atan2(-f[0], -f[2]);
};
const nearCorner = (t: number) => t > 36.5 && t < 38.2;

describe('walkPoseSamples', () => {
  it('samples at 30 Hz with orientation rows, t in ms from 0', () => {
    const c = cal();
    const samples = walkPoseSamples(fitFor(c), raw, rows, c, end);
    expect(samples).toHaveLength(Math.floor(end * 30) + 1);
    expect(samples[0]?.t).toBe(0);
    expect(samples[1]?.t).toBeCloseTo(1000 / 30, 9);
    expect(samples[samples.length - 1]?.t).toBeCloseTo(end * 1000, 6);
  });

  it('samples at 10 Hz without orientation', () => {
    const c = cal();
    const samples = walkPoseSamples(fitFor(c), raw, null, c, end);
    expect(samples).toHaveLength(Math.floor(end * 10) + 1);
    expect(samples[1]?.t).toBeCloseTo(100, 9);
  });

  it('puts the camera at the fit, the height above the ground', () => {
    const c = cal();
    const fit = fitFor(c);
    for (const s of walkPoseSamples(fit, raw, rows, c, end)) {
      const a = fit.at(s.t / 1000);
      if (!a) throw new Error('no fit');
      expect(dist([s.pos[0], s.pos[2]], a.xz)).toBeLessThan(1e-9);
      expect(s.pos[1]).toBeCloseTo(a.groundY + 1.7, 9);
    }
  });

  it('heads like the fit, turned by the yaw offset', () => {
    for (const [o, r] of [
      [0, rows],
      [90, rows],
      [90, null],
    ] as const) {
      const c = cal(o);
      const fit = fitFor(c);
      for (const s of walkPoseSamples(fit, raw, r, c, end)) {
        const t = s.t / 1000;
        if (nearCorner(t)) continue;
        const a = fit.at(t);
        if (!a) throw new Error('no fit');
        expect(Math.abs(angleDiff(yawOf(s), a.headingRad + (o * Math.PI) / 180))).toBeLessThan(
          1e-4,
        );
      }
    }
    // Looking east on the first leg.
    const c = cal();
    const s10 = walkPoseSamples(fitFor(c), raw, rows, c, end)[300];
    expect(s10 && yawOf(s10)).toBeCloseTo(-Math.PI / 2, 4);
  });

  it('is empty while the walk is not placed', () => {
    const c = { ...cal(), pins: [pinAtTruth(raw, 4)] };
    expect(walkPoseSamples(fitFor(c), raw, rows, c, end)).toEqual([]);
  });
});

describe('walkPathPoints', () => {
  it('follows the stills and marks the kept ones', () => {
    const c = cal();
    const fit = fitFor(c);
    const { line, stills } = walkPathPoints(fit, raw, end);
    expect(line).toHaveLength(1);
    expect(line[0]).toHaveLength(raw.stills.length);
    expect(stills.map((s) => s.n)).toEqual(raw.kept);
  });

  it('splits the line where it turns dashed, joined', () => {
    const pins = [4, 25].map((t) => pinAtTruth(broken, t));
    const fit = fitWalk(broken, { pins, yawOffsetDeg: 0 }, noDrawings, end);
    const { line } = walkPathPoints(fit, broken, end);
    expect(line.map((l) => l[0]?.dashed)).toEqual([false, true]);
    const lastSolid = line[0]?.[line[0].length - 1];
    expect(lastSolid && line[1]?.[0] && dist(lastSolid.xz, line[1][0].xz)).toBe(0);
  });
});
