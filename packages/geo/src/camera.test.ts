import { describe, expect, it } from 'vitest';
import { cameraQuatFromGimbal, lensFromFocal35 } from './camera';

describe('cameraQuatFromGimbal', () => {
  it('is the identity looking north and level', () => {
    const q = cameraQuatFromGimbal(0, 0, 0);
    expect(q[3]).toBeCloseTo(1, 12);
  });

  it('turns about +Y by minus the heading', () => {
    const q = cameraQuatFromGimbal(90, 0, 0);
    expect(q[1]).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(q[3]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  /** v turned by q (three.js `applyQuaternion`), rounded. */
  const turn = (
    [x, y, z, w]: readonly [number, number, number, number],
    [vx, vy, vz]: readonly [number, number, number],
  ) => {
    const ix = w * vx + y * vz - z * vy;
    const iy = w * vy + z * vx - x * vz;
    const iz = w * vz + x * vy - y * vx;
    const iw = -x * vx - y * vy - z * vz;
    return [
      ix * w - iw * x - iy * z + iz * y,
      iy * w - iw * y - iz * x + ix * z,
      iz * w - iw * z - ix * y + iy * x,
    ].map((c) => Math.round(c * 1e9) / 1e9 + 0);
  };

  it('looking straight down, the image top points along the heading (no gimbal lock)', () => {
    // north is -Z, east +X; the camera looks down its -Z with +Y up in the image
    const cases: [number, number[]][] = [
      [0, [0, 0, -1]],
      [90, [1, 0, 0]],
      [180, [0, 0, 1]],
      [-90, [-1, 0, 0]],
    ];
    for (const [yaw, up] of cases) {
      const q = cameraQuatFromGimbal(yaw, -90, 0);
      expect(turn(q, [0, 0, -1])).toEqual([0, -1, 0]);
      expect(turn(q, [0, 1, 0])).toEqual(up);
    }
  });
});

describe('lensFromFocal35', () => {
  it('uses the full width of a full-frame 3:2 photo for its own aspect', () => {
    expect(lensFromFocal35(200, 1.5, 1.5).hfovDeg).toBeCloseTo(10.29, 2);
  });
});
