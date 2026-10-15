import { Matrix4, PerspectiveCamera, Vector3, Vector4 } from 'three';
import { describe, expect, it } from 'vitest';
import { boxToLocal, boxToWorld, fitBox, worldViewProj } from './cleanupFrame';

const origin = [500000, 3200000, 5] as const;

describe('cleanup frames', () => {
  it('moves a clip box between world and local without changing it', () => {
    const world = {
      center: [500012, 3200034, 9] as [number, number, number],
      size: [4, 6, 8] as [number, number, number],
      yaw: 0.3,
      keep: 'outside' as const,
    };
    const local = boxToLocal(world, origin);
    expect(local).toEqual({ center: [12, 4, -34], size: [4, 6, 8], yaw: 0.3 });
    expect(boxToWorld(local, origin, 'outside')).toEqual(world);
  });

  it('stores world-to-clip matrices that project a world point where the stage draws it', () => {
    const cam = new PerspectiveCamera(50, 1.5, 0.1, 5000);
    cam.position.set(30, 40, 60);
    cam.lookAt(10, 0, -20);
    cam.updateMatrixWorld();
    const local = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const vp = worldViewProj(local.toArray(), origin);
    const p = new Vector3(12, 3, -25); // local
    const clipLocal = new Vector4(p.x, p.y, p.z, 1).applyMatrix4(local);
    const w = new Vector4(origin[0] + p.x, origin[1] - p.z, origin[2] + p.y, 1);
    const e = vp;
    const at = (r: number) =>
      (e[r] ?? 0) * w.x + (e[4 + r] ?? 0) * w.y + (e[8 + r] ?? 0) * w.z + (e[12 + r] ?? 0) * w.w;
    const clipWorld = [at(0), at(1), at(2), at(3)];
    expect((clipWorld[0] ?? 0) / (clipWorld[3] ?? 0)).toBeCloseTo(clipLocal.x / clipLocal.w, 6);
    expect((clipWorld[1] ?? 0) / (clipWorld[3] ?? 0)).toBeCloseTo(clipLocal.y / clipLocal.w, 6);
  });

  it('fits a box to the layer bounds with a small margin', () => {
    expect(fitBox({ min: [10, 20, 0], max: [110, 70, 10] })).toEqual({
      center: [60, 45, 5],
      size: [101, 50.5, 10.1],
      yaw: 0,
      keep: 'inside',
    });
    expect(fitBox({ min: [0, 0, 3], max: [0, 0, 3] }).size).toEqual([0.1, 0.1, 0.1]);
  });
});
