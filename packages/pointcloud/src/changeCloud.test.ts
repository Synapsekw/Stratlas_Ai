/** Change clouds (M8 cloud change) through the adapter: the Distance field, its colours, the threshold. */
import type { SceneHandle } from '@aio/engine';
import { clearAdapters } from '@aio/engine';
import type { Layer } from '@aio/schema';
import type { BufferGeometry, Vector2 } from 'three';
import { PerspectiveCamera, Points, Scene } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPointcloudAdapter } from './adapter';
import type { CopcSource } from './copc';
import type { PointMaterial } from './material';
import type { Decoder } from './pool';
import { createPointcloudSettings } from './settings';
import { pointcloudStats } from './stats';

type CloudLayer = Extract<Layer, { kind: 'pointcloud' }>;

function fakeHandle() {
  const frames = new Set<(dt: number) => void>();
  const camera = new PerspectiveCamera(60, 1, 0.1, 10000);
  camera.position.set(32, 5000, 32);
  camera.lookAt(32, 32, 32);
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
    projectionReceivers: () => [],
    raycast: () => null,
    clippingPlanes: [],
    addRaycastProvider: () => () => undefined,
  } as unknown as SceneHandle;
  return {
    handle,
    frame: () => {
      for (const f of frames) f(16);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const layout = {
  pointDataRecordFormat: 7,
  pointDataRecordLength: 40,
  scale: [0.001, 0.001, 0.001] as const,
  offset: [0, 0, 0] as const,
};
const DISTANCE = { name: 'Distance', dataType: 9, options: 0, size: 4, description: '' };

/** One decoder for the scene (as the app has): files named change* carry a Distance field. */
function sceneDecoder() {
  const jobs: Parameters<Decoder['decode']>[0][] = [];
  const source = (url: string): CopcSource => ({
    layout,
    cube: { min: [0, 0, 0], max: [64, 64, 64] },
    spacing: 1,
    pointCount: 10,
    rootPage: { pageOffset: 10, pageLength: 64 },
    ...(url.includes('/change') ? { extraBytes: [DISTANCE] } : {}),
  });
  const decoder: Decoder = {
    decode(job) {
      jobs.push(job);
      const n = 10;
      const scalar =
        job.kind === 'copc' && job.layout.scalar
          ? Float32Array.from({ length: n }, (_, i) => i / 10)
          : undefined;
      return Promise.resolve({
        id: 0,
        count: n,
        position: new Uint16Array(n * 3),
        rgb: new Uint8Array(n * 3),
        intensity: new Uint8Array(n),
        quant: { offset: [0, 0, 0], scale: [0.001, 0.001, 0.001] },
        bounds: { min: [0, 0, 0], max: [64, 64, 64] },
        heights: Float32Array.from([0, 1]),
        ...(scalar ? { scalar } : {}),
      });
    },
    copcSource: (url) => Promise.resolve(source(url)),
    copcPage: () =>
      Promise.resolve({
        nodes: { '0-0-0-0': { pointCount: 10, pointDataOffset: 1000, pointDataLength: 100 } },
        pages: {},
      }),
    dispose: vi.fn(),
  };
  return { decoder, jobs };
}

const layerOf = (id: string, scalar?: CloudLayer['scalar']): CloudLayer => ({
  kind: 'pointcloud',
  id,
  name: id,
  visible: true,
  src: { path: `clouds/${id}.copc.laz` },
  format: 'copc',
  ...(scalar ? { scalar } : {}),
});

function scene() {
  const { handle, frame } = fakeHandle();
  const settings = createPointcloudSettings(null);
  settings.getState().setEdl(false);
  const ctx = {
    scene: handle,
    url: (r: { path: string } | { hash: string }) =>
      'path' in r ? `aio://project/p/${r.path}` : 'x',
  };
  const d = sceneDecoder();
  const adapter = createPointcloudAdapter({
    decoder: () => d.decoder,
    settings,
    origin: () => [0, 64, 0],
  });
  const open = async (id: string, scalar?: CloudLayer['scalar']) => {
    await adapter.create(layerOf(id, scalar), ctx);
    return d;
  };
  return { handle, frame, settings, open };
}

const materials = (handle: SceneHandle) => {
  const out: PointMaterial[] = [];
  handle.scene.traverse((o) => {
    if (o instanceof Points) out.push(o.material as PointMaterial);
  });
  return out;
};

const SIGNED = {
  dim: 'Distance',
  label: 'Distance',
  unit: 'm',
  range: [-0.5, 0.5] as [number, number],
  diverging: true,
};

describe('change clouds', () => {
  afterEach(clearAdapters);

  it('decodes the Distance field with every point and draws it as a scalar attribute', async () => {
    const { handle, frame, open } = scene();
    const d = await open('change', SIGNED);
    frame();
    await flush();
    frame();
    const job = d.jobs[0];
    expect(job?.kind === 'copc' ? job.layout.scalar : null).toEqual({
      name: 'Distance',
      byteOffset: 36,
      type: 'f32',
    });
    let attr = false;
    handle.scene.traverse((o) => {
      if (o instanceof Points && (o.geometry as BufferGeometry).hasAttribute('aScalar'))
        attr = true;
    });
    expect(attr).toBe(true);
    expect(materials(handle)[0]?.defines).toHaveProperty('HAS_SCALAR');
    expect(pointcloudStats.getState().byScene.get(handle)?.scalar).toEqual({
      label: 'Distance',
      unit: 'm',
      range: 0.5,
      diverging: true,
    });
  });

  it('a Distance field the layer does not describe is shown unsigned up to 30 cm', async () => {
    const { handle, frame, open } = scene();
    await open('change-legacy');
    frame();
    await flush();
    frame();
    expect(pointcloudStats.getState().byScene.get(handle)?.scalar).toMatchObject({
      range: 0.3,
      diverging: false,
    });
  });

  it('colours with the layer range and the threshold; plain clouds step aside', async () => {
    const { handle, frame, settings, open } = scene();
    await open('change', SIGNED);
    await open('plain');
    settings.getState().setColourMode('change');
    settings.getState().setChangeThreshold(0.1);
    frame();
    await flush();
    frame();
    const ms = materials(handle);
    const scalar = ms.find((m) => 'HAS_SCALAR' in m.defines);
    const plain = ms.find((m) => !('HAS_SCALAR' in m.defines));
    expect(scalar?.uniforms.uScalarRange.value).toBe(0.5);
    expect(scalar?.uniforms.uDiverging.value).toBe(1);
    expect(scalar?.uniforms.uThreshold.value).toBe(0.1);
    expect(plain?.uniforms.uHideNoScalar.value).toBe(1);
    // a hand-set range wins; leaving the change mode shows the plain cloud again
    settings.getState().setChangeRange(0.2);
    settings.getState().setColourMode('rgb');
    frame();
    expect(scalar?.uniforms.uScalarRange.value).toBe(0.2);
    expect(plain?.uniforms.uHideNoScalar.value).toBe(0);
  });
});
