import { describe, expect, it } from 'vitest';
import type { XZ } from './horizontal';
import { applySim2, sim2Between, sim2FromPairs, sim2Through, sim2Yaw } from './similarity2';

const close = (a: XZ, b: XZ) => {
  expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-9);
};

describe('sim2Between', () => {
  it('refuses a transform that would ignore the finish constraint', () => {
    expect(sim2Between([0, 0], [10, 0], [5, 5], [5, 5])).toBeNull();
  });

  it('anchors a truly closed raw pair without collapsing its shape', () => {
    const m = sim2Between([0, 0], [0, 0], [5, 5], [5, 5]);
    if (!m) throw new Error('no closed transform');
    close(applySim2(m, [0, 0]), [5, 5]);
    close(applySim2(m, [10, 0]), [15, 5]);
    expect(m.s).toBe(1);
  });
});

describe('sim2FromPairs', () => {
  it('maps both pairs exactly', () => {
    const a0: XZ = [1, 2];
    const a1: XZ = [4, -1];
    const b0: XZ = [10, 10];
    const b1: XZ = [12, 30];
    const m = sim2FromPairs(a0, a1, b0, b1);
    if (!m) throw new Error('degenerate');
    close(applySim2(m, a0), b0);
    close(applySim2(m, a1), b1);
  });

  it('finds scale and turn', () => {
    const m = sim2FromPairs([0, 0], [1, 0], [0, 0], [0, 2]);
    expect(m?.s).toBeCloseTo(2, 12);
    // A complex quarter turn on [x, z] is Ry(-pi/2).
    expect(m && sim2Yaw(m)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('is null when the raw pair coincides', () => {
    expect(sim2FromPairs([1, 1], [1, 1], [0, 0], [5, 0])).toBeNull();
  });

  it('keeps the turn and scale when moved through a point', () => {
    const m = sim2FromPairs([0, 0], [1, 0], [0, 0], [0, 2]);
    if (!m) throw new Error('degenerate');
    const t = sim2Through(m, [3, 3], [7, 7]);
    close(applySim2(t, [3, 3]), [7, 7]);
    expect(t.s).toBe(m.s);
  });
});
