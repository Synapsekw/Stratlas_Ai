import type { SceneHandle } from '@aio/engine';
import type { Vector2 } from 'three';
import { PerspectiveCamera, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createPointcloudAdapter } from './adapter';
import { frustumPlanes } from './octree';
import type { Decoder } from './pool';
import type { DecodedChunk, DecodeRequest } from './protocol';
import { refineAround } from './refine';
import { createPointcloudSettings } from './settings';

function fakeHandle() {
  const frames = new Set<(dt: number) => void>();
  const camera = new PerspectiveCamera(60, 1, 0.1, 5000);
  camera.position.set(0, 50, 100);
  camera.updateMatrixWorld();
  const handle = {
    scene: new Scene(),
    camera,
    renderer: {
      clippingPlanes: [],
      capabilities: { logarithmicDepthBuffer: false },
      getPixelRatio: () => 1,
      getDrawingBufferSize: (v: Vector2) => v.set(800, 600),
      domElement: { clientWidth: 800, clientHeight: 600 },
    },
    projectId: 'p',
    requestRender: vi.fn(),
    onFrame: (cb: (dt: number) => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
    holdContinuous: () => () => undefined,
    clippingPlanes: [],
    addRaycastProvider: () => () => undefined,
    addContentBounds: () => () => undefined,
  } as unknown as SceneHandle;
  return {
    handle,
    frame: () => {
      for (const f of frames) f(16);
    },
  };
}

function fakeDecoder() {
  const jobs: Omit<DecodeRequest, 'id'>[] = [];
  const resolvers: (() => void)[] = [];
  const decoder: Decoder = {
    decode(job) {
      jobs.push(job);
      // decoded bounds replace a flat chunk's bounds, so keep each chunk where the index puts it
      const x = Number(/c(-?\d+)\.png$/.exec(job.url)?.[1] ?? 0);
      return new Promise<DecodedChunk>((resolve) => {
        resolvers.push(() => {
          resolve({
            id: 0,
            count: 10,
            position: new Int16Array(30),
            intensity: new Uint8Array(10),
            bounds: { min: [x, 0, 0], max: [x + 20, 10, 20] },
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
      for (const r of resolvers.splice(0)) r();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const chunk = (x: number, lod: number) => ({
  file: `clouds/c${String(x)}.png`,
  points: 1000,
  lod,
  bounds: { min: [x, 0, 0], max: [x + 20, 10, 20] },
});
const index = {
  schema: 'aio.pngcloud/1',
  bounds: { min: [-500, 0, 0], max: [500, 10, 20] },
  chunks: [chunk(0, 0), chunk(-10, 1), chunk(400, 1)],
};

async function setup() {
  const { handle, frame } = fakeHandle();
  const d = fakeDecoder();
  const adapter = createPointcloudAdapter({
    decoder: () => d.decoder,
    settings: createPointcloudSettings(null),
    fetchJson: () => Promise.resolve(index),
  });
  handle.camera.lookAt(0, 0, 10); // c400 lies outside this view
  handle.camera.updateMatrixWorld();
  await adapter.create(
    {
      kind: 'pointcloud',
      id: 'pc',
      name: 'pc',
      visible: true,
      src: { path: 'clouds/pc.json' },
      format: 'png-packed',
    },
    { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
  );
  frame();
  d.finishAll();
  await flush();
  frame();
  return { handle, frame, d };
}

const eye = [410, 30, 60] as const;
const focus = {
  eye,
  planes: frustumPlanes({ eye, target: [410, 0, 10], fovDeg: 40, aspect: 1, near: 0.1, far: 500 }),
  pxPerM: 1000,
};
const urls = (d: ReturnType<typeof fakeDecoder>) => d.jobs.map((j) => j.url);

describe('refineAround', () => {
  it('loads the nodes a photo sees, then settles and reports their depth', async () => {
    const { handle, frame, d } = await setup();
    expect(urls(d)).not.toContain('aio://project/p/clouds/c400.png');
    const done = refineAround(handle, focus, 2000);
    frame();
    expect(urls(d)).toContain('aio://project/p/clouds/c400.png');
    d.finishAll();
    await flush();
    frame();
    frame();
    const r = await done;
    expect(r.settled).toBe(true);
    expect(r.depth).toBe(1);
    r.release();
    r.release(); // twice is harmless
  });

  it('gives up after the timeout when no frame comes', async () => {
    const { handle } = await setup();
    const r = await refineAround(handle, focus, 30);
    expect(r.settled).toBe(false);
    r.release();
  });

  it('resolves at once on a scene without clouds', async () => {
    const { handle } = fakeHandle();
    const r = await refineAround(handle, focus);
    expect(r).toMatchObject({ depth: 0, settled: true });
  });
});
