import type { AdapterContext, SceneHandle } from '@aio/engine';
import { clearAdapters, getAdapter } from '@aio/engine';
import { emptyCleanup, type Layer } from '@aio/schema';
import type { BufferGeometry, Vector2, Box3 } from 'three';
import { PerspectiveCamera, Plane, Points, Scene, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cloudLowHeight,
  createPointcloudAdapter,
  getCloudManager,
  registerPointcloudAdapters,
} from './adapter';
import { createCleanupRecipes } from './cleanup/store';
import { pointSizePx, type PointMaterial } from './material';
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
  const bounds: { get: () => Box3 | null; solid: boolean }[] = [];
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
    addContentBounds: (get: () => Box3 | null, o?: { solid?: boolean }) => {
      const entry = { get, solid: o?.solid === true };
      bounds.push(entry);
      return () => bounds.splice(bounds.indexOf(entry), 1);
    },
  } as unknown as SceneHandle;
  const frame = () => {
    for (const f of frames) f(16);
  };
  return { handle, frame, requestRender, frames, bounds };
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

/**
 * Every drawn node: its on-screen point size in pixels (the shader's formula at the node's
 * centre), its material, and its colour state (mode, elevation range, tint, class colours).
 */
function drawn(handle: SceneHandle) {
  handle.scene.updateMatrixWorld(true);
  const out: { key: string; px: number; material: PointMaterial; colour: string }[] = [];
  handle.scene.traverse((o) => {
    if (!(o instanceof Points)) return;
    const m = o.material as PointMaterial;
    const u = m.uniforms;
    const c = (o.geometry as BufferGeometry).boundingSphere?.center.clone() ?? new Vector3();
    const depth = -c.applyMatrix4(o.matrixWorld).applyMatrix4(handle.camera.matrixWorldInverse).z;
    out.push({
      key: String(o.userData.chunk),
      px: pointSizePx(
        u.uSize.value,
        u.uPxPerM.value,
        depth,
        u.uMinPx.value,
        u.uMaxPx.value,
        (u as { uScale?: { value: number } }).uScale?.value ?? 1,
      ),
      material: m,
      colour: JSON.stringify([
        u.uMode.value,
        u.uHeight.value.toArray(),
        u.uTint.value.getHex(),
        u.uClassColours.value.map((x) => x.getHex()),
        u.uClassShown.value,
      ]),
    });
  });
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const index0 = { min: [0, 0, 0], max: [20, 10, 20] };

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

  it('the size slider scales the on-screen size of kit and png points, not their colour', async () => {
    const { handle, frame } = fakeHandle();
    const d = fakeDecoder(1000);
    const settings = createPointcloudSettings(null);
    settings.getState().setEdl(false);
    settings.getState().setColourMode('height');
    const index = {
      schema: 'aio.pngcloud/1',
      bounds: { min: [0, 0, 0], max: [20, 10, 20] },
      spacing: 0.5,
      chunks: [{ file: 'clouds/c0.png', points: 1000, lod: 0, bounds: index0 }],
    };
    const adapter = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings,
      fetchJson: () => Promise.resolve(index),
    });
    handle.camera.lookAt(0, 0, 0);
    handle.camera.updateMatrixWorld();
    const url = (r: { path: string } | { hash: string }) =>
      'path' in r ? `aio://project/p/${r.path}` : 'x';
    await adapter.create(kitLayer('f101'), { scene: handle, url });
    await adapter.create(
      { ...kitLayer('pc'), format: 'png-packed', src: { path: 'clouds/pc.json' } },
      { scene: handle, url },
    );
    frame();
    d.finishAll();
    await flush();
    // one frame per decoded node: on a slow machine the 4 ms upload budget takes one per frame
    frame();
    frame();
    const at1 = drawn(handle);
    expect(at1.map((n) => n.key)).toEqual(['f101#0', 'pc#clouds/c0.png']);
    // about 110 m away a 2.5 cm kit point is far under a pixel: it draws at the 1 px floor
    const [kit, png] = at1.map((n) => n.px);
    expect(kit).toBe(1);
    expect(png).toBeGreaterThan(2);
    for (const scale of [0.25, 0.5, 2, 4]) {
      settings.getState().setSizeScale(scale);
      frame();
      const now = drawn(handle);
      now.forEach((n, i) => {
        const was = at1[i];
        // the size follows the slider, bounded below by one pixel
        expect(n.px).toBeCloseTo(Math.max(1, (was?.px ?? 0) * scale), 5);
        expect(n.material).toBe(was?.material);
        expect(n.colour).toBe(was?.colour);
      });
    }
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
    bounds: { min: [10, 20, 0], max: [30, 60, 5] },
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
    opts: { layer?: CloudLayer; origin?: [number, number, number] } = {},
  ) {
    const { handle, frame, bounds } = fakeHandle();
    handle.camera.position.set(...eye);
    handle.camera.lookAt(32, 32, 32);
    handle.camera.updateMatrixWorld();
    const d = copcDecoder(hier, heights);
    const settings = createPointcloudSettings(null);
    settings.getState().setEdl(false);
    const origin = opts.origin ?? [0, 64, 0];
    const adapter = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings,
      origin: () => origin,
    });
    const ctx: AdapterContext = {
      scene: handle,
      url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x'),
    };
    const layer = await adapter.create(opts.layer ?? copcLayer, ctx);
    return { handle, frame, d, layer, settings, bounds, adapter, ctx };
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

  it('frames Home by the header bounds in the local frame while shown', async () => {
    const { bounds, layer } = await open(
      { 10: { nodes: { '0-0-0-0': info(500, 1000) }, pages: {} } },
      [32, 500, 32],
    );
    expect(bounds).toHaveLength(1);
    expect(bounds[0]?.solid).toBe(true);
    // origin E 0, N 64, H 0: x = E, y = H, z = 64 - N
    expect(bounds[0]?.get()?.min.toArray()).toEqual([10, 0, 4]);
    expect(bounds[0]?.get()?.max.toArray()).toEqual([30, 5, 44]);
    layer.setVisible(false);
    expect(bounds[0]?.get()).toBeNull();
    layer.dispose();
    expect(bounds).toHaveLength(0);
  });

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
    // A slow machine (a CI runner): attaching one node outlasts the frame's 4 ms upload budget,
    // so the two decoded nodes land one per frame. Each frame attaches at least one node, so two
    // frames after the decode attach both on any machine.
    let t = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (t += 5));
    frame();
    await flush();
    frame();
    frame();
    clock.mockRestore();
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

  it('the size slider scales every node at its own depth size, sharing one uniform', async () => {
    const nodes: CopcHierarchy['nodes'] = { '0-0-0-0': info(500, 1000) };
    ['1-0-0-0', '1-1-0-0', '2-0-0-0'].forEach((k, i) => {
      nodes[k] = info(500, 2000 + i);
    });
    // up close: 4x the depth size passes the 24 px ceiling, which grows with the slider too
    const { handle, frame, settings } = await open({ 10: { nodes, pages: {} } }, [33, 40, 33]);
    settings.getState().setColourMode('height');
    for (let i = 0; i < 6; i++) {
      frame();
      await flush();
    }
    const at1 = drawn(handle);
    expect(at1).toHaveLength(4);
    // nodes draw with their depth's material: more than one size on screen
    expect(new Set(at1.map((n) => n.material)).size).toBeGreaterThan(1);
    for (const scale of [0.25, 4]) {
      settings.getState().setSizeScale(scale);
      frame();
      const now = drawn(handle);
      now.forEach((n, i) => {
        const was = at1[i];
        expect(n.key).toBe(was?.key);
        expect(n.px).toBeCloseTo(Math.max(1, (was?.px ?? 0) * scale), 5);
        expect(n.material).toBe(was?.material);
        expect(n.colour).toBe(was?.colour);
      });
      // one scale uniform for every depth: a size change uploads nothing per node
      expect(new Set(now.map((n) => n.material.uniforms.uScale)).size).toBe(1);
    }
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

  const rootOnly = { 10: { nodes: { '0-0-0-0': info(500, 1000) }, pages: {} } };

  it('streams a COPC from the layer frame origin', async () => {
    const { frame, d, handle, bounds } = await open(rootOnly, [32, 5000, 32], undefined, {
      layer: { ...copcLayer, heightOffsetM: -30 },
      origin: [0, 64, 100],
    });
    frame();
    // y = Z - (H - heightOffsetM): decoded against H 130
    expect(d.jobs.map((j) => (j.kind === 'copc' ? j.origin : null))).toEqual([[0, 64, 130]]);
    const seeds = getCloudManager(handle)?.layers.get('full')?.chunks ?? [];
    expect(seeds.length).toBeGreaterThan(0);
    for (const c of seeds) {
      expect(c.source.kind === 'copc' ? c.source.origin : null).toEqual([0, 64, 130]);
    }
    // the header bounds (Z 0..5) frame Home 30 m lower
    expect(bounds[0]?.get()?.min.y).toBe(-130);
    expect(bounds[0]?.get()?.max.y).toBe(-125);
  });

  it('re-streams the cloud at the new height when its offset changes', async () => {
    // the stage disposes a layer whose definition changed and creates it again (LayerSync)
    const { frame, d, handle, bounds, layer, adapter, ctx } = await open(rootOnly, [32, 5000, 32]);
    frame();
    await flush();
    expect(d.jobs.at(-1)).toMatchObject({ origin: [0, 64, 0] });
    layer.dispose();
    const moved = await adapter.create({ ...copcLayer, heightOffsetM: 2.5 }, ctx);
    frame();
    await flush();
    expect(d.jobs.at(-1)).toMatchObject({ origin: [0, 64, -2.5] });
    expect(bounds).toHaveLength(1);
    expect(bounds[0]?.get()?.min.y).toBe(2.5);
    expect(getCloudManager(handle)?.layers.get('full')?.copc?.origin).toEqual([0, 64, -2.5]);
    moved.dispose();
  });

  it('keeps the layer frame origin when a noise run swaps the streamed file', async () => {
    const cleanup = createCleanupRecipes();
    const { handle } = fakeHandle();
    const d = copcDecoder(rootOnly);
    const adapter = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings: createPointcloudSettings(null),
      origin: () => [0, 64, 0],
      cleanup,
    });
    await adapter.create(
      { ...copcLayer, heightOffsetM: 4 },
      { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
    );
    const path = 'edits/pointcloud/full.noise-j1.copc.laz';
    cleanup.getState().set('full', {
      ...emptyCleanup('full'),
      noise: {
        path,
        params: { outlier: { meanK: 8, multiplier: 2 } },
        marked: 3,
        total: 10,
        runId: 'j1',
      },
    });
    await flush();
    await flush();
    const l = getCloudManager(handle)?.layers.get('full');
    expect(l?.copc?.url).toBe(`aio://project/p/${path}`);
    expect(l?.copc?.origin).toEqual([0, 64, -4]);
  });

  /** A COPC decoder whose headers arrive only when the test releases them, in any order. */
  function gatedCopc() {
    const gates: (() => void)[] = [];
    /** A fresh decoder per manager that, like the worker pool, fails once disposed. */
    const makeDecoder = (): Decoder => {
      const d = copcDecoder(rootOnly);
      let dead = false;
      const alive = () => {
        if (dead) throw new Error('decoder disposed');
      };
      const page = d.decoder.copcPage?.bind(d.decoder);
      const decode = d.decoder.decode.bind(d.decoder);
      return {
        ...d.decoder,
        decode: (job) => {
          alive();
          return decode(job);
        },
        copcSource: () =>
          new Promise<CopcSource>((resolve, reject) => {
            gates.push(() => {
              if (dead) reject(new Error('decoder disposed'));
              else resolve(source);
            });
          }),
        copcPage: (url, p) => {
          alive();
          if (!page) throw new Error('no copcPage');
          return page(url, p);
        },
        dispose: () => {
          dead = true;
        },
      };
    };
    const { handle } = fakeHandle();
    const settings = createPointcloudSettings(null);
    // EDL off: the clouds' groups live in the main scene
    settings.getState().setEdl(false);
    const adapter = createPointcloudAdapter({
      decoder: makeDecoder,
      settings,
      origin: () => [0, 64, 0],
    });
    const ctx: AdapterContext = {
      scene: handle,
      url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x'),
    };
    /** Every cloud group drawn in the scene. */
    const groups = () => {
      const out: string[] = [];
      handle.scene.traverse((o) => {
        if (o.name.startsWith('pointcloud:')) out.push(o.name);
      });
      return out;
    };
    return { handle, adapter, ctx, gates, groups };
  }

  it('keeps one group, the newest, when two creates of a layer resolve out of order', async () => {
    const { handle, adapter, ctx, gates, groups } = gatedCopc();
    // the stage dropped the first (offset changed) and created the layer again
    const older = adapter.create(copcLayer, ctx);
    const newer = adapter.create({ ...copcLayer, heightOffsetM: 2.5 }, ctx);
    await flush();
    gates[1]?.();
    const b = await newer;
    gates[0]?.();
    const a = await older;
    a.dispose(); // the stage disposes the stale handle it no longer wants
    expect(groups()).toEqual(['pointcloud:full']);
    expect(getCloudManager(handle)?.layers.get('full')?.copc?.origin).toEqual([0, 64, -2.5]);
    b.dispose();
    expect(groups()).toEqual([]);
    expect(getCloudManager(handle)).toBeUndefined();
  });

  it('keeps the decoder alive for the newer create when the stale one resolves first', async () => {
    const { handle, adapter, ctx, gates, groups } = gatedCopc();
    const older = adapter.create(copcLayer, ctx);
    const newer = adapter.create({ ...copcLayer, heightOffsetM: 2.5 }, ctx);
    await flush();
    gates[0]?.();
    (await older).dispose();
    gates[1]?.();
    const b = await newer;
    expect(groups()).toEqual(['pointcloud:full']);
    expect(getCloudManager(handle)?.layers.get('full')?.copc?.origin).toEqual([0, 64, -2.5]);
    b.dispose();
    expect(getCloudManager(handle)).toBeUndefined();
  });

  it('adds nothing when a create resolves after the newer one was disposed', async () => {
    const { handle, adapter, ctx, gates, groups } = gatedCopc();
    const older = adapter.create(copcLayer, ctx);
    const newer = adapter.create({ ...copcLayer, heightOffsetM: 1 }, ctx);
    await flush();
    gates[1]?.();
    (await newer).dispose();
    gates[0]?.();
    const a = await older;
    expect(groups()).toEqual([]);
    expect(getCloudManager(handle)).toBeUndefined();
    a.dispose();
    expect(groups()).toEqual([]);
  });

  it('replaces, not duplicates, a layer the manager is given twice', async () => {
    const { handle, layer } = await open(rootOnly, [32, 5000, 32]);
    const m = getCloudManager(handle);
    const first = m?.layers.get('full');
    m?.addLayer('full', [], 1);
    let n = 0;
    m?.root.traverse((o) => {
      if (o.name === 'pointcloud:full') n += 1;
    });
    expect(n).toBe(1);
    expect(first?.group.parent).toBeNull();
    layer.dispose();
  });

  it('gives the low height of a streamed, shown cloud only', async () => {
    const { frame, handle, layer } = await open(rootOnly, [32, 5000, 32]);
    // not streamed yet: no samples
    expect(cloudLowHeight(handle, 'full')).toBeNull();
    frame();
    await flush();
    frame();
    // the 2nd percentile of the root heights: the stray point at -500 is ignored
    expect(cloudLowHeight(handle, 'full')).toBeCloseTo(0.18, 2);
    expect(cloudLowHeight(handle, 'full', 0)).toBe(-500);
    expect(cloudLowHeight(handle, 'other')).toBeNull();
    layer.setVisible(false);
    expect(cloudLowHeight(handle, 'full')).toBeNull();
    layer.setVisible(true);
    expect(cloudLowHeight(handle, 'full')).not.toBeNull();
  });
});

describe('png-packed height offset', () => {
  it('lifts png-packed chunks by the offset', async () => {
    const { handle, frame, bounds } = fakeHandle();
    const d = fakeDecoder(10);
    const index = {
      schema: 'aio.pngcloud/1',
      bounds: { min: [0, 0, 0], max: [50, 10, 50] },
      chunks: [{ file: 'clouds/c0.png', points: 10, lod: 0, bounds: index0 }],
    };
    const adapter = createPointcloudAdapter({
      decoder: () => d.decoder,
      settings: createPointcloudSettings(null),
      fetchJson: () => Promise.resolve(index),
    });
    await adapter.create(
      {
        ...kitLayer('pc'),
        format: 'png-packed',
        src: { path: 'clouds/pc.json' },
        heightOffsetM: 2,
      },
      { scene: handle, url: (r) => ('path' in r ? `aio://project/p/${r.path}` : 'x') },
    );
    const seed = getCloudManager(handle)?.layers.get('pc')?.chunks[0];
    expect(seed?.bounds.min[1]).toBe(2);
    expect(seed?.bounds.max[1]).toBe(12);
    expect(seed?.source.kind === 'png' ? seed.source.quant.offset[1] : null).toBe(2);
    expect(bounds[0]?.get()?.min.y).toBe(2);
    expect(bounds[0]?.get()?.max.y).toBe(12);
    frame();
    expect(d.jobs[0]).toMatchObject({ kind: 'png', quant: { offset: [0, 2, 0] } });
  });
});
