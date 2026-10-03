import type { AdapterContext, SceneHandle } from '@aio/engine';
import { clearAdapters, getAdapter } from '@aio/engine';
import type { Layer } from '@aio/schema';
import type { Vector2 } from 'three';
import { PerspectiveCamera, Plane, Points, Scene, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPointcloudAdapter, registerPointcloudAdapters } from './adapter';
import { createPointcloudSettings } from './settings';
import type { Decoder } from './pool';
import type { DecodedChunk, DecodeRequest } from './protocol';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

function fakeHandle() {
  const frames = new Set<(dt: number) => void>();
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 5000);
  camera.position.set(0, 50, 100);
  camera.updateMatrixWorld();
  const renderer = {
    clippingPlanes: [],
    capabilities: { logarithmicDepthBuffer: false },
    getPixelRatio: () => 1,
    getDrawingBufferSize: (v: Vector2) => v.set(800, 600),
    domElement: { clientWidth: 800, clientHeight: 600 },
  };
  const requestRender = vi.fn();
  const handle = {
    scene,
    camera,
    renderer,
    projectId: 'p',
    requestRender,
    onFrame: (cb: (dt: number) => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
    holdContinuous: () => () => undefined,
    projectionReceivers: () => [],
    raycast: () => null,
    clippingPlanes: [],
    addRaycastProvider: () => () => undefined,
  } as unknown as SceneHandle;
  const frame = () => {
    for (const f of frames) f(16);
  };
  return { handle, frame, requestRender, frames };
}

function fakeDecoder(points = 10) {
  const jobs: Omit<DecodeRequest, 'id'>[] = [];
  const resolvers: (() => void)[] = [];
  const decoder: Decoder = {
    decode(job) {
      jobs.push(job);
      return new Promise<DecodedChunk>((resolve) => {
        resolvers.push(() => {
          resolve({
            id: 0,
            count: points,
            position: new Int16Array(points * 3),
            intensity: new Uint8Array(points),
            bounds: { min: [0, 0, 0], max: [1, 1, 1] },
          });
        });
      });
    },
    dispose: vi.fn(),
  };
  return {
    decoder,
    jobs,
    finishAll: () => {
      resolvers.splice(0).forEach((r) => {
        r();
      });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const kitLayer = (id: string): CloudLayer => ({
  kind: 'pointcloud',
  id,
  name: id,
  visible: true,
  src: { path: `clouds/${id}.bin` },
  format: 'kit-packed',
});

describe('pointcloud adapter', () => {
  afterEach(clearAdapters);

  it('registers once for the pointcloud kind', () => {
    registerPointcloudAdapters();
    registerPointcloudAdapters();
    expect(getAdapter('pointcloud')?.kind).toBe('pointcloud');
  });

  it('loads a kit-packed layer in the decoder and requests a render when it lands', async () => {
    const { handle, frame, requestRender } = fakeHandle();
    const d = fakeDecoder();
    const adapter = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings: createPointcloudSettings(null),
    });
    const ctx: AdapterContext = {
      scene: handle,
      url: (r) => `aio://project/p/${'path' in r ? r.path : r.hash}`,
    };
    const layer = await adapter.create(kitLayer('f101'), ctx);
    frame();
    expect(d.jobs).toEqual([{ kind: 'kit', url: 'aio://project/p/clouds/f101.bin', scale: 0.001 }]);
    d.finishAll();
    await flush();
    expect(requestRender).toHaveBeenCalled();
    let points = 0;
    handle.scene.traverse((o) => {
      if (o instanceof Points) points += 1;
    });
    // EDL is on by default: the points live in the private EDL scene, the composite quad in the main one
    expect(handle.scene.getObjectByName('PointCloudEDLComposite')).toBeTruthy();
    expect(points).toBe(0);
    layer.dispose();
    expect(handle.scene.getObjectByName('PointCloudEDLComposite')).toBeFalsy();
  });

  it('joins SceneHandle.raycast while clouds are shown and shares the section planes', async () => {
    const { handle, frame } = fakeHandle();
    const providers: unknown[] = [];
    const planes = [new Plane(new Vector3(1, 0, 0), 0)];
    Object.assign(handle, {
      clippingPlanes: planes,
      addRaycastProvider: (p: unknown) => {
        providers.push(p);
        return () => providers.splice(providers.indexOf(p), 1);
      },
    });
    const d = fakeDecoder();
    const settings = createPointcloudSettings(null);
    settings.getState().setEdl(false);
    const adapter = createPointcloudAdapter({ decoder: () => d.decoder, settings });
    const a = await adapter.create(kitLayer('f101'), { scene: handle, url: () => 'x' });
    const b = await adapter.create(kitLayer('f102'), { scene: handle, url: () => 'y' });
    expect(providers).toHaveLength(1);
    frame();
    d.finishAll();
    await flush();
    let material: unknown = null;
    handle.scene.traverse((o) => {
      if (o instanceof Points) material = o.material;
    });
    expect((material as { clippingPlanes: Plane[] } | null)?.clippingPlanes).toBe(planes);
    a.dispose();
    expect(providers).toHaveLength(1);
    b.dispose();
    expect(providers).toHaveLength(0);
  });

  it('puts points straight into the main scene with EDL off', async () => {
    const { handle, frame } = fakeHandle();
    const d = fakeDecoder();
    const settings = createPointcloudSettings(null);
    settings.getState().setEdl(false);
    const adapter = createPointcloudAdapter({ decoder: () => d.decoder, settings });
    await adapter.create(kitLayer('f101'), { scene: handle, url: () => 'x' });
    frame();
    d.finishAll();
    await flush();
    let points = 0;
    handle.scene.traverse((o) => {
      if (o instanceof Points) points += 1;
    });
    expect(points).toBe(1);
  });

  it('loads png-packed chunks within the budget, nearest first', async () => {
    const { handle, frame } = fakeHandle();
    const d = fakeDecoder(1000);
    const settings = createPointcloudSettings(null);
    settings.getState().setBudget(1_000_000);
    const chunk = (i: number, lod: number, points: number) => ({
      file: `clouds/c${i}.png`,
      points,
      lod,
      bounds: { min: [i * 100, 0, 0], max: [i * 100 + 50, 10, 50] },
    });
    const index = {
      schema: 'aio.pngcloud/1',
      bounds: { min: [0, 0, 0], max: [1000, 10, 50] },
      chunks: [
        chunk(0, 0, 400_000),
        chunk(9, 1, 400_000),
        chunk(1, 1, 400_000),
        chunk(2, 1, 400_000),
      ],
    };
    const adapter = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings,
      fetchJson: () => Promise.resolve(index),
    });
    await adapter.create(
      { ...kitLayer('pc'), format: 'png-packed', src: { path: 'clouds/pc.json' } },
      { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
    );
    frame();
    expect(d.jobs.map((j) => j.url)).toEqual([
      'aio://project/p/clouds/c0.png',
      'aio://project/p/clouds/c1.png',
    ]);
  });

  it('rejects formats it does not read yet', async () => {
    const { handle } = fakeHandle();
    const adapter = createPointcloudAdapter({ decoder: () => fakeDecoder().decoder });
    await expect(
      adapter.create({ ...kitLayer('c'), format: 'copc' }, { scene: handle, url: () => 'x' }),
    ).rejects.toThrow('not supported yet');
  });
});
