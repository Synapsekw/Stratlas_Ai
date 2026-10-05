import { describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '@aio/schema';
import { cameraQuatLookAlong } from './math';

/** v turned by q (three.js `applyQuaternion`), rounded. */
function turn([x, y, z, w]: Quat, [vx, vy, vz]: Vec3): Vec3 {
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  const r = (c: number) => Math.round(c * 1e6) / 1e6 + 0;
  return [
    r(ix * w - iw * x - iy * z + iz * y),
    r(iy * w - iw * y - iz * x + ix * z),
    r(iz * w - iw * z - ix * y + iy * x),
  ];
}

describe('cameraQuatLookAlong near nadir (kit photo poses)', () => {
  it('keeps the image top along the way the camera leans, either way round', () => {
    // a camera 89.9 deg down leaning north (-Z), then south (+Z), world up as the kit gives it
    const e = Math.tan((0.1 * Math.PI) / 180);
    const north = cameraQuatLookAlong([0, -1, -e], [0, 1, 0]);
    expect(turn(north, [0, 1, 0])[2]).toBeCloseTo(-1, 4);
    const south = cameraQuatLookAlong([0, -1, e], [0, 1, 0]);
    expect(turn(south, [0, 1, 0])[2]).toBeCloseTo(1, 4);
  });

  it('follows an explicit up vector looking straight down', () => {
    const q = cameraQuatLookAlong([0, -1, 0], [1, 0, 0]);
    expect(turn(q, [0, 0, -1])).toEqual([0, -1, 0]);
    expect(turn(q, [0, 1, 0])).toEqual([1, 0, 0]);
  });
});
