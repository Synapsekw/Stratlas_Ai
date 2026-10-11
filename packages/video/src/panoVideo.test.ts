import { describe, expect, it } from 'vitest';
import { lookTarget, panoSphereGeometry } from './panoVideo';

/** Unit direction of the sphere vertex whose texture coordinate is nearest to (u, v). */
function directionAt(u: number, v: number): [number, number, number] {
  const g = panoSphereGeometry();
  const uv = g.getAttribute('uv');
  const pos = g.getAttribute('position');
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < uv.count; i++) {
    const d = Math.hypot(uv.getX(i) - u, uv.getY(i) - v);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const p: [number, number, number] = [pos.getX(best), pos.getY(best), pos.getZ(best)];
  const len = Math.hypot(...p);
  g.dispose();
  return [p[0] / len, p[1] / len, p[2] / len];
}

const close = (a: readonly number[], b: readonly number[]) => {
  a.forEach((x, i) => {
    expect(x).toBeCloseTo(b[i] ?? 0, 5);
  });
};

describe('panoSphereGeometry', () => {
  it('puts the picture centre along local north and the right of it to the east', () => {
    close(directionAt(0.5, 0.5), [0, 0, -1]);
    close(directionAt(0.75, 0.5), [1, 0, 0]);
    close(directionAt(0.25, 0.5), [-1, 0, 0]);
    close(directionAt(0, 0.5), [0, 0, 1]);
  });

  it('puts the top of the picture overhead and the bottom underfoot', () => {
    close(directionAt(0.5, 1), [0, 1, 0]);
    close(directionAt(0.5, 0), [0, -1, 0]);
  });

  it('faces inward: the triangles wind towards the centre', () => {
    const g = panoSphereGeometry();
    const pos = g.getAttribute('position');
    const index = g.getIndex();
    expect(index).not.toBeNull();
    if (!index) return;
    // a triangle near the horizon: its normal (a to b, cross, a to c) points at the origin
    const t = Math.floor(index.count / 6) * 3;
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)].map(
      (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)] as const,
    );
    if (!a || !b || !c) return;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ] as const;
    expect(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]).toBeLessThan(0);
    g.dispose();
  });
});

describe('lookTarget', () => {
  it('turns yaw clockwise from north and pitch up from the horizon', () => {
    close(lookTarget({ yawDeg: 0, pitchDeg: 0, fovDeg: 70 }), [0, 0, -1]);
    close(lookTarget({ yawDeg: 90, pitchDeg: 0, fovDeg: 70 }), [1, 0, 0]);
    close(lookTarget({ yawDeg: 0, pitchDeg: 89, fovDeg: 70 }).slice(1, 2), [
      Math.sin((89 * Math.PI) / 180),
    ]);
  });
});
