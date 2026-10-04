import type { Vec3 } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { applyMat4, fitSimilarity3D, type PointPair } from './similarity';

/** Rotation about +Y by `deg` then about +X by `tilt`, scaled and shifted. */
function truth(deg: number, tilt: number, s: number, t: Vec3) {
  const a = (deg * Math.PI) / 180;
  const b = (tilt * Math.PI) / 180;
  return (p: Vec3): Vec3 => {
    // Rx(b)
    const y1 = Math.cos(b) * p[1] - Math.sin(b) * p[2];
    const z1 = Math.sin(b) * p[1] + Math.cos(b) * p[2];
    // Ry(a)
    const x2 = Math.cos(a) * p[0] + Math.sin(a) * z1;
    const z2 = -Math.sin(a) * p[0] + Math.cos(a) * z1;
    return [s * x2 + t[0], s * y1 + t[1], s * z2 + t[2]];
  };
}

const SRC: Vec3[] = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 0, -12],
  [3, 25, -4],
  [-6, 8, 5],
];

describe('fitSimilarity3D', () => {
  it('recovers a level turn, scale and shift (upright mode)', () => {
    const f = truth(37, 0, 1.25, [120, 4, -80]);
    const pairs: PointPair[] = SRC.map((src) => ({ src, dst: f(src) }));
    const r = fitSimilarity3D(pairs, 'upright');
    expect(r.yawDeg).toBeCloseTo(37, 6);
    expect(r.scale).toBeCloseTo(1.25, 9);
    expect(r.rms).toBeLessThan(1e-9);
    for (const p of pairs) {
      const q = applyMat4(r.matrix, p.src);
      q.forEach((v, i) => {
        expect(v).toBeCloseTo(p.dst[i] ?? NaN, 6);
      });
    }
  });

  it('recovers a tilted rotation in full mode', () => {
    const f = truth(-120, 8, 0.5, [3, 2, 1]);
    const pairs: PointPair[] = SRC.map((src) => ({ src, dst: f(src) }));
    const r = fitSimilarity3D(pairs, 'full');
    expect(r.scale).toBeCloseTo(0.5, 9);
    expect(r.rms).toBeLessThan(1e-9);
    const q = applyMat4(r.matrix, [1, 2, 3]);
    const want = f([1, 2, 3]);
    q.forEach((v, i) => {
      expect(v).toBeCloseTo(want[i] ?? NaN, 6);
    });
  });

  it('fits the plan only from targets without a height (map clicks)', () => {
    const f = truth(90, 0, 1, [50, 7, 50]);
    const pairs: PointPair[] = SRC.map((src, i) => ({
      src,
      dst: f(src),
      ...(i < 3 ? { horizontalOnly: true } : {}),
    }));
    const r = fitSimilarity3D(pairs, 'upright');
    expect(r.yawDeg).toBeCloseTo(90, 6);
    expect(applyMat4(r.matrix, [0, 0, 0])[1]).toBeCloseTo(7, 6);
    expect(r.residuals[0]).toBeLessThan(1e-9);
  });

  it('keeps the height when no target has one', () => {
    const f = truth(10, 0, 1, [5, 0, 5]);
    const pairs: PointPair[] = SRC.slice(0, 3).map((src) => ({
      src,
      dst: f(src),
      horizontalOnly: true,
    }));
    const r = fitSimilarity3D(pairs, 'upright', { heightOffset: 42 });
    expect(applyMat4(r.matrix, [0, 1, 0])[1]).toBeCloseTo(43, 6);
  });

  it('reports a residual per pair', () => {
    const f = truth(0, 0, 1, [0, 0, 0]);
    const pairs: PointPair[] = SRC.slice(0, 4).map((src) => ({ src, dst: f(src) }));
    const moved = pairs[3];
    if (moved) moved.dst = [moved.dst[0] + 0.4, moved.dst[1], moved.dst[2]];
    const r = fitSimilarity3D(pairs, 'upright');
    expect(r.residuals).toHaveLength(4);
    expect(r.max).toBeGreaterThan(0.2);
    expect(r.rms).toBeGreaterThan(0.1);
    expect(r.max).toBe(Math.max(...r.residuals));
  });

  it('refuses too few or degenerate pairs', () => {
    expect(() => fitSimilarity3D([{ src: [0, 0, 0], dst: [1, 1, 1] }], 'upright')).toThrow(
      /at least/i,
    );
    const line: PointPair[] = [0, 1, 2].map((i) => ({ src: [i, 0, 0], dst: [i, 0, 0] }));
    expect(() => fitSimilarity3D(line, 'full')).toThrow(/line/i);
    const same: PointPair[] = [0, 1].map(() => ({ src: [1, 1, 1], dst: [2, 2, 2] }));
    expect(() => fitSimilarity3D(same, 'upright')).toThrow(/apart/i);
  });
});
