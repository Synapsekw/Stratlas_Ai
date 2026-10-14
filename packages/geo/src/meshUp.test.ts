import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  Z_UP,
  fitModelPlacement,
  mulMat4,
  placeZUp,
  upAxisOf,
  withUpAxis,
} from './meshUp';
import { applyMat4 } from './similarity';

const close = (a: readonly number[], b: readonly number[]) => {
  a.forEach((v, i) => {
    expect(v).toBeCloseTo(b[i] ?? NaN, 9);
  });
};

describe('up axis', () => {
  it('turns z up into the scene frame: (x, y, z) to (x, z, -y)', () => {
    expect(applyMat4(Z_UP, [1, 2, 3])).toEqual([1, 3, -2]);
  });
  it('places a z-up model at a local point', () => {
    expect(applyMat4(placeZUp([10, 20, 30]), [1, 2, 3])).toEqual([11, 23, 28]);
  });
  it('reads the up axis back from a transform, scaled and turned about the vertical too', () => {
    expect(upAxisOf(IDENTITY)).toBe('y');
    expect(upAxisOf(Z_UP)).toBe('z');
    const yaw = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 5, 6, 7, 1]; // 90 deg about y, scale 2
    expect(upAxisOf(yaw)).toBe('y');
    expect(upAxisOf(mulMat4(yaw, Z_UP))).toBe('z');
  });
  it('flips the up axis in place and keeps the translation', () => {
    const t = placeZUp([5, 6, 7]);
    const y = withUpAxis(t, 'y');
    close(y, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    close(withUpAxis(y, 'z'), t);
    expect(withUpAxis(t, 'z')).toEqual(t);
  });
  it('a level fit of a z-up model keeps it upright', () => {
    // a tower 10 m tall along model z, moved 100 m east and 50 m north (z -50)
    const src: [number, number, number][] = [
      [0, 0, 0],
      [4, 0, 0],
      [0, 4, 10],
    ];
    const truth = (p: [number, number, number]) => {
      const q = applyMat4(Z_UP, p);
      return [q[0] + 100, q[1], q[2] - 50] as [number, number, number];
    };
    const fit = fitModelPlacement(
      src.map((s) => ({ src: s, dst: truth(s) })),
      'upright',
      {},
      'z',
    );
    expect(upAxisOf(fit.matrix)).toBe('z');
    expect(fit.rms).toBeLessThan(1e-6);
    close(applyMat4(fit.matrix, [0, 4, 10]), truth([0, 4, 10]));
  });
});
