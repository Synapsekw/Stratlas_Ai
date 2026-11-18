import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { swipePlane, toLocalFn } from './geometry';

describe('toLocalFn', () => {
  it('maps easting, northing and height into the local frame', () => {
    expect(toLocalFn([100, 200, 10])(101, 199, 12)).toEqual([1, 2, 1]);
  });
});

describe('swipePlane', () => {
  it('keeps what is right of the divider', () => {
    const cam = new PerspectiveCamera(50, 1, 0.1, 1000);
    cam.position.set(0, 0, 10);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const centre = swipePlane(cam, 0.5);
    expect(centre.distanceToPoint(new Vector3(1, 0, 0))).toBeGreaterThan(0);
    expect(centre.distanceToPoint(new Vector3(-1, 0, 0))).toBeLessThan(0);
    const left = swipePlane(cam, 0.25);
    expect(left.distanceToPoint(new Vector3(-1, 0, 0))).toBeGreaterThan(0);
  });
});
