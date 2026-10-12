import type { Quat, Vec3, WalkRawPath } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { loadRaw } from '../__fixtures__/walk';
import {
  horizontalPath,
  quatFromUnitVectors,
  quatFromYawPitchRoll,
  rotateVec,
  yawPitchRoll,
} from './horizontal';

const close = (a: readonly number[], b: readonly number[], tol = 1e-9) => {
  a.forEach((v, i) => {
    expect(Math.abs(v - (b[i] ?? Number.NaN))).toBeLessThan(tol);
  });
};

describe('quaternion helpers', () => {
  it('turns one unit vector onto another, including the opposite one', () => {
    const cases: [Vec3, Vec3][] = [
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, 1],
        [0, 1, 0],
      ],
      [
        [0, -1, 0],
        [0, 1, 0],
      ],
      [
        [0, 1, 0],
        [0, 1, 0],
      ],
    ];
    for (const [from, to] of cases) close(rotateVec(quatFromUnitVectors(from, to), from), to);
  });

  it('round-trips yaw, pitch and roll', () => {
    const q = quatFromYawPitchRoll(0.7, -0.3, 0.2);
    const e = yawPitchRoll(q);
    close([e.yaw, e.pitch, e.roll], [0.7, -0.3, 0.2]);
    // Yaw only: a three.js camera turned -90 degrees looks east (+X).
    close(rotateVec(quatFromYawPitchRoll(-Math.PI / 2, 0, 0), [0, 0, -1]), [1, 0, 0]);
  });
});

describe('horizontalPath', () => {
  it('keeps x and z when up is +Y', () => {
    const raw = loadRaw('synthetic');
    const h = horizontalPath(raw);
    expect(h.t).toHaveLength(raw.stills.length);
    const s = raw.stills[50];
    close(h.xz[50] ?? [], [s?.pos?.[0] ?? 0, s?.pos?.[2] ?? 0]);
    expect(h.segment[50]).toBe(0);
  });

  it('levels a tilted frame (up along +Z) and nulls unregistered stills', () => {
    const tilt: Quat = quatFromUnitVectors([0, 1, 0], [0, 0, 1]);
    const raw: WalkRawPath = {
      schema: 'aio.walkpath/1',
      walk: 'w',
      source: 'sfm',
      up: [0, 0, 1],
      stills: [
        { n: 0, t: 0, pos: rotateVec(tilt, [2, 5, 3]), steps: 0 },
        { n: 1, t: 1, steps: 1 },
      ],
    };
    const h = horizontalPath(raw);
    close(h.xz[0] ?? [], [2, 3]);
    expect(h.xz[1]).toBeNull();
    expect(h.segment[1]).toBeNull();
  });

  it('takes up from the cameras when it is absent', () => {
    const tilt: Quat = quatFromUnitVectors([0, 1, 0], [1, 0, 0]);
    const raw: WalkRawPath = {
      schema: 'aio.walkpath/1',
      walk: 'w',
      source: 'sfm',
      stills: [{ n: 0, t: 0, pos: rotateVec(tilt, [2, 5, 3]), q: tilt, steps: 0 }],
    };
    close(horizontalPath(raw).xz[0] ?? [], [2, 3]);
  });
});
