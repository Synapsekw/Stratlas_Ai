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
});

describe('lensFromFocal35', () => {
  it('uses the full width of a full-frame 3:2 photo for its own aspect', () => {
    expect(lensFromFocal35(200, 1.5, 1.5).hfovDeg).toBeCloseTo(10.29, 2);
  });
});
