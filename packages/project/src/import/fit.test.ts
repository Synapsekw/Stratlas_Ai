import { describe, expect, it } from 'vitest';
import { applySimilarity2D, fitSimilarity2D } from './fit';

describe('fitSimilarity2D', () => {
  it('recovers a plant grid turned 17.9991 deg clockwise to UTM north', () => {
    const alpha = (17.9991 * Math.PI) / 180;
    // clockwise turn: plant north (0, 1) maps to (sin a, cos a)
    const toUtm = ([e, n]: [number, number]): [number, number] => [
      e * Math.cos(alpha) + n * Math.sin(alpha) + 799_000,
      -e * Math.sin(alpha) + n * Math.cos(alpha) + 3_241_000,
    ];
    const src: [number, number][] = [
      [0, 0],
      [1300, 450],
      [2600, 1080],
      [-60, 20],
    ];
    const f = fitSimilarity2D(src.map((s) => ({ src: s, dst: toUtm(s) })));
    expect(f.thetaDeg).toBeCloseTo(-17.9991, 9);
    expect(f.scale).toBeCloseTo(1, 12);
    expect(f.rms).toBeLessThan(1e-6);
    const p = applySimilarity2D(f, [1000, 500]);
    const q = toUtm([1000, 500]);
    expect(Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1])).toBeLessThan(1e-6);
  });
});
