import { Matrix4, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { nearestProjected } from './pickMath';

function mvp(): Matrix4 {
  const cam = new PerspectiveCamera(60, 1, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
}

describe('nearestProjected', () => {
  it('returns the front-most point within the pixel radius', () => {
    // two points on the view axis (front one at z=2), one off to the side
    const pos = new Float32Array([0, 0, 0, 0, 0, 2, 3, 0, 0]);
    const hit = nearestProjected(pos, 3, mvp().elements, 0, 0, 0.02, 0.02);
    expect(hit?.index).toBe(1);
  });

  it('returns null when nothing is inside the radius', () => {
    const pos = new Float32Array([3, 0, 0]);
    expect(nearestProjected(pos, 1, mvp().elements, 0, 0, 0.02, 0.02)).toBeNull();
  });

  it('ignores points behind the camera', () => {
    const pos = new Float32Array([0, 0, 20]);
    expect(nearestProjected(pos, 1, mvp().elements, 0, 0, 0.5, 0.5)).toBeNull();
  });

  it('skips points rejected by the keep filter (clipping)', () => {
    const pos = new Float32Array([0, 0, 2, 0, 0, 0]);
    const hit = nearestProjected(pos, 2, mvp().elements, 0, 0, 0.02, 0.02, (_x, _y, z) => z < 1);
    expect(hit?.index).toBe(1);
  });
});
