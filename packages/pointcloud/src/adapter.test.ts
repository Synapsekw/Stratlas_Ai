import type { AdapterContext, SceneHandle } from '@aio/engine';
import { clearAdapters, getAdapter } from '@aio/engine';
import type { Layer } from '@aio/schema';
import type { BufferGeometry, Vector2 } from 'three';
import { PerspectiveCamera, Plane, Points, Scene, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPointcloudAdapter, registerPointcloudAdapters } from './adapter';
import { createPointcloudSettings } from './settings';
import { pointcloudStats } from './stats';
import type { CopcHierarchy, CopcSource } from './copc';
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
            heights: Float32Array.from([0, 0.5, 1]),
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
    frame();
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
    // decoded chunks reach the scene on the next frame
    frame();
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
    // chunks outside the view frustum are not loaded: look along the row of chunks
    handle.camera.lookAt(150, 0, 25);
    handle.camera.updateMatrixWorld();
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
      adapter.create({ ...kitLayer('c'), format: 'potree2' }, { scene: handle, url: () => 'x' }),
    ).rejects.toThrow('not supported yet');
  });

  it('skips flat chunks outside the view frustum', async () => {
    const { handle, frame } = fakeHandle();
    const d = fakeDecoder(1000);
    const chunk = (x: number, lod: number) => ({
      file: `clouds/c${x}.png`,
      points: 1000,
      lod,
      bounds: { min: [x, 0, 0], max: [x + 20, 10, 20] },
    });
    const index = {
      schema: 'aio.pngcloud/1',
      bounds: { min: [-500, 0, 0], max: [500, 10, 20] },
      chunks: [chunk(0, 0), chunk(-10, 1), chunk(400, 1)],
    };
    const adapter = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings: createPointcloudSettings(null),
      fetchJson: () => Promise.resolve(index),
    });
    handle.camera.lookAt(0, 0, 10); // c400 lies far to the right, outside the 60 degree view
    handle.camera.updateMatrixWorld();
    await adapter.create(
      { ...kitLayer('pc'), format: 'png-packed', src: { path: 'clouds/pc.json' } },
      { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
    );
    frame();
    expect(d.jobs.map((j) => j.url)).toEqual([
      'aio://project/p/clouds/c0.png',
      'aio://project/p/clouds/c-10.png',
    ]);
  });

  it('publishes whether the clouds carry RGB and their height range for the UI', async () => {
    const { handle, frame } = fakeHandle();
    const d = fakeDecoder();
    const settings = createPointcloudSettings(null);
    settings.getState().setColourMode('height');
    const adapter = createPointcloudAdapter({ decoder: () => d.decoder, settings });
    await adapter.create(kitLayer('f101'), { scene: handle, url: () => 'x' });
    frame();
    // a kit-packed cloud is intensity only, known before it is decoded
    expect(pointcloudStats.getState().byScene.get(handle)?.rgb).toBe(false);
    d.finishAll();
    await flush();
    frame();
    expect(pointcloudStats.getState().byScene.get(handle)?.heightRange).toEqual([0, 1]);
  });
});

describe('COPC layers', () => {
  const layout = {
    pointDataRecordFormat: 7,
    pointDataRecordLength: 36,
    scale: [0.001, 0.001, 0.001] as const,
    offset: [0, 0, 0] as const,
  };
  const source: CopcSource = {
    layout,
    // a 64 m cube whose local frame (origin E 0, N 64, H 0) spans x 0..64, y 0..64, z 0..64
    cube: { min: [0, 0, 0], max: [64, 64, 64] },
    spacing: 1,
    pointCount: 1000,
    rootPage: { pageOffset: 10, pageLength: 64 },
  };
  const info = (n: number, at: number) => ({
    pointCount: n,
    pointDataOffset: at,
    pointDataLength: 100,
  });

  /** Heights of a level-0 (root) node: ground 0..10 m with two stray points far off. */
  const ROOT_HEIGHTS = Float32Array.from([
    -500,
    ...Array.from({ length: 998 }, (_, i) => (i / 997) * 10),
    900,
  ]);

  function copcDecoder(
    hier: Record<number, CopcHierarchy>,
    heights: (offset: number) => Float32Array = () => ROOT_HEIGHTS,
  ) {
    const jobs: Parameters<Decoder['decode']>[0][] = [];
    const pages: number[] = [];
    const decoder: Decoder = {
      decode(job) {
        jobs.push(job);
        const n = job.kind === 'copc' ? job.node.pointCount : 1;
        return Promise.resolve({
          id: 0,
          count: n,
          position: new Uint16Array(n * 3),
          rgb: new Uint8Array(n * 3),
          intensity: new Uint8Array(n),
          classification: new Uint8Array(n).fill(2),
          classes: { 2: n },
          quant: { offset: [0, 0, 0], scale: [0.001, 0.001, 0.001] },
          bounds: { min: [0, 0, 0], max: [64, 64, 64] },
          heights: heights(job.kind === 'copc' ? job.node.pointDataOffset : 0),
        });
      },
      copcSource: () => Promise.resolve(source),
      copcPage: (_url, page) => {
        pages.push(page.pageOffset);
        const h = hier[page.pageOffset];
        return h ? Promise.resolve(h) : Promise.reject(new Error('no page'));
      },
      dispose: vi.fn(),
    };
    return { decoder, jobs, pages };
  }

  const copcLayer: CloudLayer = {
    kind: 'pointcloud',
    id: 'full',
    name: 'Full cloud',
    visible: true,
    src: { path: 'clouds/full.copc.laz' },
    format: 'copc',
  };

  async function open(
    hier: Record<number, CopcHierarchy>,
    eye: [number, number, number],
    heights?: (offset: number) => Float32Array,
  ) {
    const { handle, frame } = fakeHandle();
    handle.camera.position.set(...eye);
    handle.camera.lookAt(32, 32, 32);
    handle.camera.updateMatrixWorld();
    const d = copcDecoder(hier, heights);
    const settings = createPointcloudSettings(null);
    settings.getState().setEdl(false);
    const adapter = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings,
      origin: () => [0, 64, 0],
    });
    const layer = await adapter.create(copcLayer, {
      scene: handle,
      url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x'),
    });
    return { handle, frame, d, layer, settings };
  }

  /** The elevation uniform of every drawn node. */
  function rampRanges(handle: SceneHandle): [number, number][] {
    const out: [number, number][] = [];
    handle.scene.traverse((o) => {
      if (!(o instanceof Points)) return;
      const u = (o.material as { uniforms: { uHeight: { value: Vector2 } } }).uniforms.uHeight;
      out.push([u.value.x, u.value.y]);
    });
    return out;
  }

  it('reads the header and root page in the decoder, then loads the root node first', async () => {
    const { frame, d } = await open(
      { 10: { nodes: { '0-0-0-0': info(500, 1000), '1-0-0-0': info(100, 2000) }, pages: {} } },
      [32, 5000, 32],
    );
    expect(d.pages).toEqual([10]);
    frame();
    // far away the root spacing (1 m) projects under a pixel: only the root loads
    expect(d.jobs).toEqual([
      {
        kind: 'copc',
        url: 'aio://project/p/clouds/full.copc.laz',
        node: info(500, 1000),
        layout,
        origin: [0, 64, 0],
        box: { min: [0, 0, 0], max: [64, 64, 64] },
      },
    ]);
  });

  it('refines into child nodes up close and fetches hierarchy pages it reaches', async () => {
    const root = {
      nodes: { '0-0-0-0': info(500, 1000), '1-0-0-0': info(100, 2000) },
      pages: { '1-1-1-1': { pageOffset: 20, pageLength: 32 } },
    };
    const child = { nodes: { '1-1-1-1': info(50, 3000) }, pages: {} };
    const { frame, d } = await open({ 10: root, 20: child }, [32, 80, 32]);
    frame();
    await flush();
    expect(d.jobs.map((j) => (j.kind === 'copc' ? j.node.pointDataOffset : 0))).toEqual([
      1000, 2000,
    ]);
    expect(d.pages).toEqual([10, 20]);
    frame();
    await flush();
    frame();
    expect(d.jobs.map((j) => (j.kind === 'copc' ? j.node.pointDataOffset : 0))).toContain(3000);
  });

  it('publishes the classes of the loaded points for the legend', async () => {
    const { handle, frame } = await open(
      { 10: { nodes: { '0-0-0-0': info(500, 1000) }, pages: {} } },
      [32, 5000, 32],
    );
    frame();
    await flush();
    frame();
    const c = pointcloudStats.getState().byScene.get(handle);
    expect(c?.classes).toEqual({ 2: 500 });
    let hasClass = false;
    handle.scene.traverse((o) => {
      if (o instanceof Points && (o.geometry as BufferGeometry).hasAttribute('aClass'))
        hasClass = true;
    });
    expect(hasClass).toBe(true);
  });

  it('colours elevation over the point heights, not the octree cube, without outliers', async () => {
    // the 64 m cube would put 0..10 m of ground in the bottom sixth of the ramp: all blue
    const { handle, frame, settings } = await open(
      { 10: { nodes: { '0-0-0-0': info(500, 1000) }, pages: {} } },
      [32, 5000, 32],
    );
    settings.getState().setColourMode('height');
    frame();
    await flush();
    frame();
    const c = pointcloudStats.getState().byScene.get(handle);
    const [lo, hi] = c?.heightRange ?? [NaN, NaN];
    expect(lo).toBeCloseTo(0, 0);
    expect(hi).toBeCloseTo(10, 0);
    expect(c?.heightExtent).toEqual([-500, 900]);
    const ranges = rampRanges(handle);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.[0]).toBeCloseTo(lo, 5);
    expect(ranges[0]?.[1]).toBeCloseTo(hi, 5);
  });

  it('keeps one elevation range for every node as finer nodes stream in', async () => {
    const root = {
      nodes: { '0-0-0-0': info(500, 1000), '1-0-0-0': info(100, 2000) },
      pages: {},
    };
    // a child node over a 40 m stack: the coarse root sample still sets the range
    const { handle, frame, d } = await open({ 10: root }, [32, 80, 32], (off) =>
      off === 2000 ? Float32Array.from([30, 35, 40]) : ROOT_HEIGHTS,
    );
    frame();
    await flush();
    frame();
    expect(d.jobs.length).toBe(2);
    const ranges = rampRanges(handle);
    expect(ranges.length).toBe(2);
    expect(new Set(ranges.map((r) => r.join(','))).size).toBe(1);
    expect(ranges[0]?.[1]).toBeCloseTo(10, 0);
  });

  it('uses a hand-set elevation range for every node and forgets it when the cloud closes', async () => {
    const { handle, frame, settings, layer } = await open(
      { 10: { nodes: { '0-0-0-0': info(500, 1000) }, pages: {} } },
      [32, 5000, 32],
    );
    frame();
    await flush();
    settings.getState().setHeightRange([2, 6]);
    frame();
    expect(rampRanges(handle)).toEqual([[2, 6]]);
    layer.dispose();
    expect(settings.getState().heightRange).toBeNull();
  });

  it('spreads a burst of decoded nodes over frames under the upload budget', async () => {
    // a root and three children of 300 k points: 3.3 MB each on the GPU, so one per frame
    const nodes: CopcHierarchy['nodes'] = { '0-0-0-0': info(300_000, 1000) };
    ['1-0-0-0', '1-1-0-0', '1-0-1-0'].forEach((k, i) => {
      nodes[k] = info(300_000, 2000 + i);
    });
    const { handle, frame, d } = await open({ 10: { nodes, pages: {} } }, [32, 80, 32]);
    const drawn = () => {
      let n = 0;
      handle.scene.traverse((o) => {
        if (o instanceof Points) n++;
      });
      return n;
    };
    frame();
    await flush();
    expect(d.jobs).toHaveLength(4);
    const sizes = () => {
      const out: number[] = [];
      handle.scene.traverse((o) => {
        if (o instanceof Points)
          out.push((o.material as { uniforms: { uSize: { value: number } } }).uniforms.uSize.value);
      });
      return out;
    };
    const counts: number[] = [];
    frame();
    counts.push(drawn());
    // the root lands first, at the root spacing
    expect(sizes()).toEqual([1]);
    for (let i = 0; i < 4; i++) {
      frame();
      counts.push(drawn());
    }
    expect(counts).toEqual([1, 2, 3, 4, 4]);
    // with its children loaded the root draws at their (finer) spacing, like them
    expect(sizes()).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});
