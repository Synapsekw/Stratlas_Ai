import { describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '@aio/schema';
import {
  KIT_FRAME,
  applyMat4,
  composeFrame,
  invertFrame,
  mapPoint,
  mapQuat,
  meshTransform,
  rotateY,
} from './frames';
import { quatRotate } from './math';

const close = (a: readonly number[], b: readonly number[], eps = 1e-9) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => {
    expect(Math.abs(v - (b[i] ?? Number.NaN))).toBeLessThan(eps);
  });
};

describe('kit frame (X north, Y up, Z east) to local (X east, Y up, Z south)', () => {
  it('maps plant north to -Z and plant east to +X', () => {
    close(mapPoint(KIT_FRAME, [1, 0, 0]), [0, 0, -1]);
    close(mapPoint(KIT_FRAME, [0, 0, 1]), [1, 0, 0]);
    close(mapPoint(KIT_FRAME, [0, 1, 0]), [0, 1, 0]);
  });

  it('maps a known tank point (nozzle N1B: n -1.664, up 9.129, e 0.12)', () => {
    close(mapPoint(KIT_FRAME, [-1.664, 9.129, 0.12]), [0.12, 9.129, 1.664]);
  });

  it('rotates a camera so it still looks at the same physical target', () => {
    // Camera at kit origin looking plant north (kit +X): three.js camera looks down its -Z.
    // A camera rotated -90 deg about Y looks along +X.
    const s = Math.SQRT1_2;
    const qKit: Quat = [0, -s, 0, s];
    close(quatRotate(qKit, [0, 0, -1]), [1, 0, 0]);
    const qLocal = mapQuat(KIT_FRAME, qKit);
    // In the local frame plant north is -Z.
    close(quatRotate(qLocal, [0, 0, -1]), [0, 0, -1]);
  });

  it('bakes the same rotation into a column-major mesh transform', () => {
    const m = meshTransform(KIT_FRAME);
    expect(m).toHaveLength(16);
    const p: Vec3 = [1.165, 0.035, -0.38];
    close(applyMat4(m, p), mapPoint(KIT_FRAME, p));
  });
});

describe('frame round trips', () => {
  it('inverts a rotated and offset frame to 1e-9', () => {
    const f = composeFrame(rotateY(17.9991), [-1234.5, -100, 678.9]);
    const inv = invertFrame(f);
    const pts: Vec3[] = [
      [0, 0, 0],
      [1245.2, 80.1, -610.4],
      [-1280, 0.3, 410],
    ];
    for (const p of pts) close(mapPoint(inv, mapPoint(f, p)), p, 1e-9);
    const q: Quat = [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)];
    close(mapQuat(inv, mapQuat(f, q)), q, 1e-12);
  });

  it('agrees between point mapping and mesh transform for a rotated frame', () => {
    const f = composeFrame(rotateY(-23), [5, 6, 7]);
    const p: Vec3 = [3, -2, 11];
    close(applyMat4(meshTransform(f), p), mapPoint(f, p), 1e-9);
  });
});
