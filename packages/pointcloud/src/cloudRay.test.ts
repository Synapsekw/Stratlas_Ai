import type { RayProvider, SceneHandle } from '@aio/engine';
import type { Vector2 } from 'three';
import { PerspectiveCamera, Plane, Scene, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createPointcloudAdapter } from './adapter';
import { cloudRayProvider, pointsInPrism } from './cloudRay';
import type { Decoder } from './pool';
import { createPointcloudSettings } from './settings';

async function load(
  clippingPlanes: Plane[] = [],
  classification?: Uint8Array,
  settings = createPointcloudSettings(null),
) {
  const frames = new Set<() => void>();
  const providers: RayProvider[] = [];
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
    clippingPlanes,
    addRaycastProvider: () => () => undefined,
    addRayProvider: (p: RayProvider) => {
      providers.push(p);
      return () => providers.splice(providers.indexOf(p), 1);
    },
    addContentBounds: () => () => undefined,
    requestRender: () => undefined,
    onFrame: (cb: () => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
  } as unknown as SceneHandle;
  const decoder: Decoder = {
    decode: () =>
      Promise.resolve({
        id: 0,
        count: 3,
        position: new Int16Array([0, 0, 0, 0, 0, 2000, 3000, 0, 0]),
        intensity: new Uint8Array(3),
        bounds: { min: [0, 0, 0], max: [3, 0, 2] },
        ...(classification ? { classification } : {}),
      }),
    dispose: () => undefined,
  };
  const adapter = createPointcloudAdapter({
    decoder: () => decoder,
    settings,
  });
  const layer = await adapter.create(
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
  for (const f of frames) f();
  return { handle, providers, layer, frames };
}

const o = new Vector3(0, 0, 10);
const d = new Vector3(0, 0, -1);

describe('cloudRayProvider', () => {
  it('is registered with the stage while a cloud shows and names its loaded layers', async () => {
    const { handle, providers, layer } = await load();
    expect(providers).toHaveLength(1);
    expect(cloudRayProvider(handle).layers()).toEqual(['f101']);
    layer.setVisible(false);
    expect(cloudRayProvider(handle).layers()).toEqual([]);
    layer.dispose();
    expect(providers).toHaveLength(0);
  });

  it('hits the nearest point along the ray with its layer on the object', async () => {
    const { handle } = await load();
    const hit = cloudRayProvider(handle).cast(o, d, 'f101', { coneRad: 0.001 });
    expect(hit?.point.distanceTo(new Vector3(0, 0, 2))).toBeLessThan(1e-6);
    expect(hit?.distance).toBeCloseTo(8, 5);
    expect(hit?.index).toBe(1);
    expect(hit?.object.userData.layerId).toBe('f101');
    expect(cloudRayProvider(handle).cast(o, d, 'other', { coneRad: 0.001 })).toBeNull();
  });

  it('skips points the section planes cut away', async () => {
    // keep z < 1 only
    const { handle } = await load([new Plane(new Vector3(0, 0, -1), 1)]);
    expect(cloudRayProvider(handle).cast(o, d, 'f101', { coneRad: 0.001 })?.index).toBe(0);
  });

  it('skips points of a hidden class', async () => {
    const settings = createPointcloudSettings(null);
    const { handle, frames } = await load([], new Uint8Array([2, 6, 2]), settings);
    expect(cloudRayProvider(handle).cast(o, d, 'f101', { coneRad: 0.001 })?.index).toBe(1);
    settings.getState().toggleClass(6);
    for (const f of frames) f();
    expect(cloudRayProvider(handle).cast(o, d, 'f101', { coneRad: 0.001 })?.index).toBe(0);
  });
});

describe('pointsInPrism', () => {
  it('takes every loaded point inside the prism, section planes or not', async () => {
    const { handle } = await load([new Plane(new Vector3(0, 0, -1), 1)]);
    const ring = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 2.5],
      [-0.5, 2.5],
    ] as const;
    const pts = pointsInPrism(handle, 'f101', { ring, minY: -1, maxY: 1 });
    expect(pts.length).toBe(6);
    expect(pointsInPrism(handle, 'nope', { ring, minY: -1, maxY: 1 }).length).toBe(0);
  });

  it('keeps the points of a hidden class', async () => {
    const settings = createPointcloudSettings(null);
    const { handle, frames } = await load([], new Uint8Array([2, 6, 2]), settings);
    settings.getState().toggleClass(6);
    for (const f of frames) f();
    const ring = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 2.5],
      [-0.5, 2.5],
    ] as const;
    expect(pointsInPrism(handle, 'f101', { ring, minY: -1, maxY: 1 }).length).toBe(6);
  });
});
