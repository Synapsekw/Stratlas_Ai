/** Cleanup recipes in the viewer (Task 6): per-layer classes, uniforms, chunk masks, the noise copy. */
import type { SceneHandle } from '@aio/engine';
import { emptyCleanup, type PointcloudCleanup } from '@aio/schema';
import type { BufferAttribute, Points, Vector2 } from 'three';
import { PerspectiveCamera, Scene } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  cloudSourceUrl,
  cloudWorldBounds,
  createPointcloudAdapter,
  getCloudManager,
} from '../adapter';
import type { CopcSource } from '../copc';
import type { Decoder } from '../pool';
import { createPointcloudSettings } from '../settings';
import { pointcloudStats } from '../stats';
import { createCleanupRecipes } from './store';

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
    addContentBounds: () => () => undefined,
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

const VP = [0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.45, 0, 0, 1];
const left: [number, number][] = [
  [-1, -1],
  [0, -1],
  [0, 1],
  [-1, 1],
];

function decoderFor(n: number, failNoise = false) {
  const mask = vi.fn();
  const source: CopcSource = {
    layout,
    cube: { min: [0, 0, 0], max: [64, 64, 64] },
    bounds: { min: [0, 54, 0], max: [9, 64, 3] },
    spacing: 1,
    pointCount: n,
    rootPage: { pageOffset: 10, pageLength: 64 },
  };
  const decoder: Decoder = {
    decode: () =>
      Promise.resolve({
        id: 0,
        count: n,
        position: Uint16Array.from({ length: 3 * n }, (_, k) => (k % 3 === 0 ? (k / 3) % 10 : 0)),
        classification: new Uint8Array(n).fill(2),
        intensity: new Uint8Array(n),
        quant: { offset: [0, 0, 0], scale: [1, 1, 1] },
        bounds: { min: [0, 0, 0], max: [9, 0, 0] },
        heights: Float32Array.from([0]),
      }),
    copcSource: (url) =>
      failNoise && url.includes('.noise-')
        ? Promise.reject(new Error('missing file'))
        : Promise.resolve(source),
    copcPage: () =>
      Promise.resolve({
        nodes: { '0-0-0-0': { pointCount: n, pointDataOffset: 1000, pointDataLength: 100 } },
        pages: {},
      }),
    mask: (job) => {
      mask(job.count);
      return Promise.resolve({ mask: new Uint8Array(job.count).fill(1), cls: null, classes: null });
    },
    dispose: vi.fn(),
  };
  return { decoder, mask };
}

async function scene(n = 10, failNoise = false, preset: PointcloudCleanup | null = null) {
  const { handle, frame } = fakeHandle();
  const settings = createPointcloudSettings(null);
  settings.getState().setEdl(false);
  const recipes = createCleanupRecipes();
  if (preset) recipes.getState().set('a', preset);
  const d = decoderFor(n, failNoise);
  const adapter = createPointcloudAdapter({
    decoder: () => d.decoder,
    settings,
    cleanup: recipes,
    origin: () => [0, 64, 0],
  });
  await adapter.create(
    {
      kind: 'pointcloud',
      id: 'a',
      name: 'a',
      visible: true,
      src: { path: 'clouds/a.copc.laz' },
      format: 'copc',
    },
    { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
  );
  const settle = async () => {
    frame();
    await flush();
    frame();
    await flush();
    frame();
  };
  await settle();
  const pts = () => {
    const out: Points[] = [];
    handle.scene.traverse((o) => {
      if ((o as Partial<Points>).isPoints) out.push(o as Points);
    });
    return out;
  };
  return { handle, settings, recipes, settle, pts, d };
}
const noiseRun = {
  path: 'edits/pointcloud/a.noise-j1.copc.laz',
  params: { outlier: { meanK: 8, multiplier: 2 } },
  marked: 3,
  total: 10,
  runId: 'j1',
};
const maskOf = (p: Points) => [...(p.geometry.getAttribute('aMask') as BufferAttribute).array];

describe('the cleanup in the viewer', () => {
  it('uses the recipe hidden classes for its layer instead of the global ones', async () => {
    const s = await scene();
    const m = getCloudManager(s.handle)?.layers.get('a')?.material;
    expect(m?.uniforms.uClassShown.value[2]).toBe(1);
    s.recipes.getState().set('a', { ...emptyCleanup('a'), hiddenClasses: [2] });
    expect(m?.uniforms.uClassShown.value[2]).toBe(0);
    s.settings.getState().toggleClass(6); // a global change does not undo the layer's set
    expect(m?.uniforms.uClassShown.value[2]).toBe(0);
    expect(m?.uniforms.uClassShown.value[6]).toBe(1);
    s.recipes.getState().set('a', null);
    expect(m?.uniforms.uClassShown.value[2]).toBe(1);
    expect(m?.uniforms.uClassShown.value[6]).toBe(0);
  });

  it('masks the points a selection covers on upload and when the regions change', async () => {
    const s = await scene();
    const [p] = s.pts();
    if (!p) throw new Error('no points');
    expect(maskOf(p)).toEqual(new Array(10).fill(0));
    const r: PointcloudCleanup = {
      ...emptyCleanup('a'),
      regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action: { kind: 'delete' } }],
    };
    s.recipes.getState().set('a', r);
    expect(maskOf(p)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    const region = r.regions[0];
    if (!region) throw new Error('no region');
    s.recipes
      .getState()
      .set('a', { ...r, regions: [{ ...region, action: { kind: 'class', value: 7 } }] });
    expect(maskOf(p)).toEqual(new Array(10).fill(0));
    expect([...(p.geometry.getAttribute('aClass') as BufferAttribute).array].slice(0, 6)).toEqual([
      7, 7, 7, 7, 7, 2,
    ]);
    s.recipes.getState().set('a', emptyCleanup('a'));
    expect([...(p.geometry.getAttribute('aClass') as BufferAttribute).array].slice(0, 6)).toEqual([
      2, 2, 2, 2, 2, 2,
    ]);
  });

  it('masks a chunk that uploads after the selection was drawn', async () => {
    const { handle, frame } = fakeHandle();
    const settings = createPointcloudSettings(null);
    settings.getState().setEdl(false);
    const recipes = createCleanupRecipes();
    recipes.getState().set('a', {
      ...emptyCleanup('a'),
      regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action: { kind: 'hide' } }],
    });
    const d = decoderFor(10);
    await createPointcloudAdapter({
      decoder: () => d.decoder,
      settings,
      cleanup: recipes,
      origin: () => [0, 64, 0],
    }).create(
      {
        kind: 'pointcloud',
        id: 'a',
        name: 'a',
        visible: true,
        src: { path: 'clouds/a.copc.laz' },
        format: 'copc',
      },
      { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
    );
    frame();
    await flush();
    frame();
    const out: Points[] = [];
    handle.scene.traverse((o) => {
      if ((o as Partial<Points>).isPoints) out.push(o as Points);
    });
    const [p] = out;
    if (!p) throw new Error('no points');
    expect(maskOf(p)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it('draws every COPC chunk with a mask-aware material, at every octree depth', async () => {
    const s = await scene();
    const ps = s.pts();
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps)
      expect('HAS_MASK' in (p.material as { defines: object }).defines).toBe(true);
  });

  it('puts the clip box and heights in the uniforms every depth material shares', async () => {
    const s = await scene();
    s.recipes.getState().set('a', {
      ...emptyCleanup('a'),
      clipBox: { center: [4.5, 64, 0], size: [5, 5, 5], yaw: 0, keep: 'inside' },
      height: { min: -1, max: 2 },
    });
    for (const p of s.pts()) {
      const u = (p.material as unknown as { uniforms: Record<string, { value: unknown }> })
        .uniforms;
      expect(u.uBoxOn?.value).toBe(1);
      expect(u.uZMin?.value).toBe(-1);
      expect(u.uZMax?.value).toBe(2);
    }
  });

  it('masks a chunk above 50,000 points in the worker', async () => {
    const s = await scene(60_000);
    s.recipes.getState().set('a', {
      ...emptyCleanup('a'),
      regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action: { kind: 'hide' } }],
    });
    await flush();
    expect(s.d.mask).toHaveBeenCalledWith(60_000);
    const [p] = s.pts();
    expect(p && maskOf(p).every((v) => v === 1)).toBe(true);
  });

  it('streams the noise copy, and the original again when the copy cannot be read', async () => {
    const s = await scene();
    expect(cloudSourceUrl(s.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');
    const noise = {
      path: 'edits/pointcloud/a.noise-j1.copc.laz',
      params: { outlier: { meanK: 8, multiplier: 2 } },
      marked: 3,
      total: 10,
      runId: 'j1',
    };
    s.recipes.getState().set('a', { ...emptyCleanup('a'), noise });
    await s.settle();
    expect(cloudSourceUrl(s.handle, 'a')).toBe(
      'aio://project/p/edits/pointcloud/a.noise-j1.copc.laz',
    );
    s.recipes.getState().set('a', emptyCleanup('a'));
    await s.settle();
    expect(cloudSourceUrl(s.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');

    const broken = await scene(10, true);
    broken.recipes.getState().set('a', { ...emptyCleanup('a'), noise });
    await broken.settle();
    expect(cloudSourceUrl(broken.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');
    expect(pointcloudStats.getState().errors.some((e) => e.includes('a.noise-j1'))).toBe(true);
  });

  it('opens on the noise copy a saved recipe names, and does not retry a copy that failed', async () => {
    const noise = {
      path: 'edits/pointcloud/a.noise-j2.copc.laz',
      params: { outlier: { meanK: 8, multiplier: 2 } },
      marked: 3,
      total: 10,
      runId: 'j2',
    };
    const s = await scene(10, false, { ...emptyCleanup('a'), noise });
    expect(cloudSourceUrl(s.handle, 'a')).toBe(
      'aio://project/p/edits/pointcloud/a.noise-j2.copc.laz',
    );

    const broken = await scene(10, true, { ...emptyCleanup('a'), noise });
    expect(cloudSourceUrl(broken.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');
    const reads = vi.spyOn(broken.d.decoder, 'copcSource');
    broken.recipes.getState().set('a', { ...emptyCleanup('a'), noise, hiddenClasses: [7] });
    await broken.settle();
    expect(reads).not.toHaveBeenCalled();
    expect(cloudSourceUrl(broken.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');
  });

  it('follows a recipe that arrives while the layer is still loading', async () => {
    const { handle, frame } = fakeHandle();
    const settings = createPointcloudSettings(null);
    settings.getState().setEdl(false);
    const recipes = createCleanupRecipes();
    const d = decoderFor(10);
    const created = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings,
      cleanup: recipes,
      origin: () => [0, 64, 0],
    }).create(
      {
        kind: 'pointcloud',
        id: 'a',
        name: 'a',
        visible: true,
        src: { path: 'clouds/a.copc.laz' },
        format: 'copc',
      },
      { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
    );
    // the saved recipe is loaded while the COPC header is read
    recipes.getState().set('a', {
      ...emptyCleanup('a'),
      noise: { ...noiseRun, path: 'edits/pointcloud/a.noise-j3.copc.laz', runId: 'j3' },
      regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action: { kind: 'hide' } }],
    });
    await created;
    for (let i = 0; i < 3; i++) {
      frame();
      await flush();
    }
    frame();
    expect(cloudSourceUrl(handle, 'a')).toBe(
      'aio://project/p/edits/pointcloud/a.noise-j3.copc.laz',
    );
    const out: Points[] = [];
    handle.scene.traverse((o) => {
      if ((o as Partial<Points>).isPoints) out.push(o as Points);
    });
    const [p] = out;
    if (!p) throw new Error('no points');
    expect(maskOf(p)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it('keeps the layer colour when the noise copy is swapped in', async () => {
    const s = await scene();
    const tint = getCloudManager(s.handle)?.layers.get('a')?.tint;
    s.recipes.getState().set('a', { ...emptyCleanup('a'), noise: noiseRun });
    await s.settle();
    expect(cloudSourceUrl(s.handle, 'a')).toContain('.noise-');
    expect(getCloudManager(s.handle)?.layers.get('a')?.tint).toBe(tint);
  });

  it('says nothing about a failed swap that a later change made moot', async () => {
    const s = await scene(10, true);
    const path = 'edits/pointcloud/a.noise-j9.copc.laz';
    s.recipes.getState().set('a', { ...emptyCleanup('a'), noise: { ...noiseRun, path } });
    s.recipes.getState().set('a', emptyCleanup('a'));
    await s.settle();
    expect(pointcloudStats.getState().errors.some((e) => e.includes('a.noise-j9'))).toBe(false);
    expect(cloudSourceUrl(s.handle, 'a')).toBe('aio://project/p/clouds/a.copc.laz');
  });

  it('drops a worker mask that a newer selection overtook', async () => {
    const s = await scene(60_000);
    const pending: ((r: { mask: Uint8Array; cls: null; classes: null }) => void)[] = [];
    s.d.decoder.mask = (job) =>
      new Promise((resolve) => {
        pending.push(() => {
          resolve({ mask: new Uint8Array(job.count).fill(1), cls: null, classes: null });
        });
      });
    s.recipes.getState().set('a', {
      ...emptyCleanup('a'),
      regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action: { kind: 'hide' } }],
    });
    expect(pending).toHaveLength(1);
    // the selection is undone before the worker answers: the mask is cleared at once
    s.recipes.getState().set('a', emptyCleanup('a'));
    pending[0]?.({ mask: new Uint8Array(0), cls: null, classes: null });
    await flush();
    const [p] = s.pts();
    expect(p && maskOf(p).every((v) => v === 0)).toBe(true);
  });

  it('moves the clip box and heights without masking the chunks again', async () => {
    const s = await scene(60_000);
    const r: PointcloudCleanup = {
      ...emptyCleanup('a'),
      regions: [{ id: 'r', shape: 'box', viewProj: VP, polygon: left, action: { kind: 'hide' } }],
    };
    s.recipes.getState().set('a', r);
    await flush();
    expect(s.d.mask).toHaveBeenCalledTimes(1);
    const compiled = getCloudManager(s.handle)?.layers.get('a')?.cleanup?.compiled.regions;
    const box = (x: number) => ({
      center: [x, 64, 0] as [number, number, number],
      size: [5, 5, 5] as [number, number, number],
      yaw: 0,
      keep: 'inside' as const,
    });
    // the regions are compared by identity first: a drag does not serialise them
    const stringify = vi.spyOn(JSON, 'stringify');
    s.recipes.getState().set('a', { ...r, clipBox: box(4.5) });
    s.recipes.getState().set('a', { ...r, clipBox: box(5) });
    s.recipes.getState().set('a', { ...r, height: { min: -1 } });
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    await flush();
    expect(s.d.mask).toHaveBeenCalledTimes(1);
    expect(getCloudManager(s.handle)?.layers.get('a')?.cleanup?.compiled.regions).toBe(compiled);
    // equal regions in a new array (an undo snapshot) do not mask again either
    s.recipes.getState().set('a', { ...r, regions: structuredClone(r.regions) });
    await flush();
    expect(s.d.mask).toHaveBeenCalledTimes(1);
  });

  it('gives the layer bounds in the project CRS', async () => {
    const s = await scene();
    expect(cloudWorldBounds(s.handle, 'a')).toEqual({ min: [0, 54, 0], max: [9, 64, 3] });
    expect(cloudWorldBounds(s.handle, 'b')).toBeNull();
  });
});
