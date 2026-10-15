import type { SceneHandle } from '@aio/engine';
import {
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  Scene,
  type Vector2,
} from 'three';
import { describe, expect, it } from 'vitest';
import { createPointcloudAdapter, getCloudManager } from '../adapter';
import { applyCleanupUniforms, createPointMaterial, NO_CLEANUP } from '../material';
import { drawnPoints } from '../pick';
import type { Decoder } from '../pool';
import { createPointcloudSettings } from '../settings';
import { countDrawn } from './count';

/** Four points along x at 0, 1, 2 and 3 m, heights 0, 1, 2 and 3 m. */
function points(mask?: number[]) {
  const geo = new BufferGeometry();
  geo.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 2, 2, 0, 3, 3, 0]), 3),
  );
  geo.setAttribute('aClass', new BufferAttribute(new Uint8Array([2, 2, 6, 2]), 1));
  if (mask) geo.setAttribute('aMask', new BufferAttribute(new Uint8Array(mask), 1));
  const m = createPointMaterial({
    hasRgb: false,
    hasIntensity: false,
    hasClass: true,
    hasMask: mask !== undefined,
    baseSize: 1,
    tint: '#000',
  });
  return { obj: new Points(geo, m), m };
}
const drawnOf = (obj: Points) => {
  const d = drawnPoints(obj);
  if (d === false) return [];
  return [0, 1, 2, 3].filter((i) => d === undefined || d(i));
};

describe('drawnPoints and the cleanup', () => {
  it('draws every point without a cleanup', () => {
    expect(drawnPoints(points().obj)).toBeUndefined();
  });

  it('skips masked points', () => {
    expect(drawnOf(points([0, 1, 0, 0]).obj)).toEqual([0, 2, 3]);
  });

  it('skips points outside the height range (local y)', () => {
    const { obj, m } = points();
    applyCleanupUniforms(m, { ...NO_CLEANUP, zMin: 0.5, zMax: 2.5 });
    expect(drawnOf(obj)).toEqual([1, 2]);
  });

  it('keeps the inside or the outside of the clip box', () => {
    const { obj, m } = points();
    // unit box scaled to 2 m around x = 1: inside for 0 <= x <= 2 (|u| <= 0.5)
    const inv = [0.5, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, -0.5, 0, 0, 1];
    applyCleanupUniforms(m, { boxInv: inv, keepInside: true, zMin: -1e30, zMax: 1e30 });
    expect(drawnOf(obj)).toEqual([0, 1, 2]);
    applyCleanupUniforms(m, { boxInv: inv, keepInside: false, zMin: -1e30, zMax: 1e30 });
    expect(drawnOf(obj)).toEqual([3]);
  });
});

describe('countDrawn', () => {
  it('counts the loaded points the materials draw, also inside a test region', async () => {
    const frames = new Set<() => void>();
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld();
    const handle = {
      scene: new Scene(),
      camera,
      renderer: {
        getPixelRatio: () => 1,
        getDrawingBufferSize: (v: Vector2) => v.set(500, 500),
        domElement: { clientWidth: 500, clientHeight: 500 },
      },
      projectId: 'p',
      clippingPlanes: [],
      addRaycastProvider: () => () => undefined,
      addContentBounds: () => () => undefined,
      requestRender: () => undefined,
      onFrame: (cb: () => void) => {
        frames.add(cb);
        return () => frames.delete(cb);
      },
    } as unknown as SceneHandle;
    // kit raw units are millimetres: (0, 0, 0), (0, 0, 2) and (3, 0, 0) m
    const decoder: Decoder = {
      decode: () =>
        Promise.resolve({
          id: 0,
          count: 3,
          position: new Int16Array([0, 0, 0, 0, 0, 2000, 3000, 0, 0]),
          intensity: new Uint8Array(3),
          bounds: { min: [0, 0, 0], max: [3, 0, 2] },
        }),
      dispose: () => undefined,
    };
    const adapter = createPointcloudAdapter({
      decoder: () => decoder,
      settings: createPointcloudSettings(null),
    });
    await adapter.create(
      {
        kind: 'pointcloud',
        id: 'k',
        name: 'k',
        visible: true,
        src: { path: 'a.bin' },
        format: 'kit-packed',
      },
      { scene: handle, url: () => 'x' },
    );
    for (const f of frames) f();
    await new Promise((r) => setTimeout(r, 0));
    for (const f of frames) f();
    expect(countDrawn(handle)).toEqual({ drawn: 3, loaded: 3 });
    expect(countDrawn(handle, 'k', (x) => x > 1)).toEqual({ drawn: 1, loaded: 3 });
    expect(countDrawn(handle, 'other')).toEqual({ drawn: 0, loaded: 0 });
    const m = getCloudManager(handle)?.layers.get('k')?.material;
    if (!m) throw new Error('no material');
    // keep x <= 1.5 only (a 3 m box around the origin)
    applyCleanupUniforms(m, {
      boxInv: [1 / 3, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1],
      keepInside: true,
      zMin: -1e30,
      zMax: 1e30,
    });
    expect(countDrawn(handle, 'k').drawn).toBe(2);
  });
});
