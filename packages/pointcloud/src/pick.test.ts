import type { SceneHandle } from '@aio/engine';
import type { Vector2 } from 'three';
import { PerspectiveCamera, Plane, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createPointcloudAdapter } from './adapter';
import type { Decoder } from './pool';
import { pickPoint } from './pick';
import { createPointcloudSettings } from './settings';

function setup(clippingPlanes: Plane[] = []) {
  const frames = new Set<() => void>();
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const handle = {
    scene: new Scene(),
    camera,
    renderer: {
      clippingPlanes,
      getPixelRatio: () => 1,
      getDrawingBufferSize: (v: Vector2) => v.set(500, 500),
      domElement: { clientWidth: 500, clientHeight: 500 },
    },
    projectId: 'p',
    requestRender: () => undefined,
    onFrame: (cb: () => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
  } as unknown as SceneHandle;
  // kit raw units are millimetres: points at z = 0 m and z = 2 m on the axis, one at x = 3 m
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
  return { handle, frames, decoder };
}

async function load(clip: Plane[] = []) {
  const { handle, frames, decoder } = setup(clip);
  const adapter = createPointcloudAdapter({
    decoder: () => decoder,
    settings: createPointcloudSettings(null),
  });
  await adapter.create(
    {
      kind: 'pointcloud',
      id: 'f101',
      name: 'f101',
      visible: true,
      src: { path: 'a.bin' },
      format: 'kit-packed',
    },
    { scene: handle, url: () => 'x' },
  );
  for (const f of frames) f();
  await new Promise((r) => setTimeout(r, 0));
  return handle;
}

describe('pickPoint', () => {
  it('returns the front-most point under the cursor in world metres', async () => {
    const handle = await load();
    const hit = pickPoint(handle, { x: 0, y: 0 });
    expect(hit?.layerId).toBe('f101');
    expect(hit?.index).toBe(1);
    expect(hit?.point.distanceTo(new Vector3(0, 0, 2))).toBeLessThan(1e-6);
    expect(hit?.distance).toBeCloseTo(8, 5);
  });

  it('returns null away from every point', async () => {
    const handle = await load();
    expect(pickPoint(handle, { x: -0.9, y: 0.9 })).toBeNull();
  });

  it('skips points cut away by the shared clipping planes', async () => {
    // keep z < 1 only
    const handle = await load([new Plane(new Vector3(0, 0, -1), 1)]);
    expect(pickPoint(handle, { x: 0, y: 0 })?.index).toBe(0);
  });
});
