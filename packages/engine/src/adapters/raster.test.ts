import type { Layer } from '@aio/schema';
import {
  Box3,
  Mesh,
  PerspectiveCamera,
  type Object3D,
  Scene,
  Texture,
  TextureLoader,
  type Plane,
  type WebGLRenderer,
} from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterContext, SceneHandle } from '../types';
import {
  ON_TOP_ORDER,
  lazyPicture,
  planDisplay,
  rasterAdapter,
  rasterDraw,
  rasterSlot,
} from './raster';

describe('raster drawing', () => {
  it('cuts the transparent no-data collar of photographic rasters away', () => {
    const ortho = rasterDraw(0, 0, false);
    expect(ortho.alphaTest).toBe(0.5);
    expect(ortho.transparent).toBe(false);
    // plans blend their transparent background instead
    const plan = rasterDraw(2, 0, true);
    expect(plan.alphaTest).toBe(0);
    expect(plan.transparent).toBe(true);
  });

  it('keeps finer levels and later layers in front on a shared plane', () => {
    expect(rasterDraw(1, 0, false).offsetUnits).toBeLessThan(rasterDraw(0, 0, false).offsetUnits);
    // the coarsest level of a later layer still beats the finest level of an earlier one
    expect(rasterDraw(0, 1, false).offsetUnits).toBeLessThan(rasterDraw(3, 0, false).offsetUnits);
    expect(rasterDraw(0, 1, false).renderOrder).toBeGreaterThan(
      rasterDraw(0, 0, false).renderOrder,
    );
  });

  it('gives each layer one stable slot', () => {
    const a = rasterSlot('test-ortho-a');
    const b = rasterSlot('test-ortho-b');
    expect(b).toBe(a + 1);
    expect(rasterSlot('test-ortho-a')).toBe(a);
  });
});

describe('how a drawing lies over the scene', () => {
  const base = rasterDraw(2, 3, true);

  it('draws as it always did until a choice is made', () => {
    expect(planDisplay(undefined, base)).toEqual({
      opacity: 1,
      depthTest: true,
      renderOrder: base.renderOrder,
    });
    expect(planDisplay({}, base).opacity).toBe(1);
  });

  it('takes the chosen opacity', () => {
    expect(planDisplay({ opacity: 0.35 }, base).opacity).toBe(0.35);
  });

  it('on top: no depth test, after the models and clouds, under what is drawn on them', () => {
    const top = planDisplay({ onTop: true }, base);
    expect(top.depthTest).toBe(false);
    // models, clouds and the ground imagery draw at 0 or below
    expect(top.renderOrder).toBeGreaterThan(0);
    expect(top.renderOrder).toBeGreaterThanOrEqual(ON_TOP_ORDER);
    // the selection highlight (2), outlines (3 and up) and the measure line (30) stay above it
    expect(top.renderOrder).toBeLessThan(2);
    // two drawings on top keep their order
    const later = planDisplay({ onTop: true }, rasterDraw(2, 4, true));
    expect(later.renderOrder).toBeGreaterThan(top.renderOrder);
  });
});

describe('a picture that is loaded when it is first shown', () => {
  const setup = () => {
    const loads: { resolve: (t: { dispose(): void }) => void; reject: (e: Error) => void }[] = [];
    const applied: unknown[] = [];
    const failed: unknown[] = [];
    const picture = lazyPicture(
      () =>
        new Promise<{ dispose(): void }>((resolve, reject) => {
          loads.push({ resolve, reject });
        }),
      (t) => applied.push(t),
      (e) => failed.push(e),
    );
    return { loads, applied, failed, picture };
  };
  const texture = () => {
    const t = { disposed: 0, dispose: () => void (t.disposed += 1) };
    return t;
  };

  it('loads nothing until it is wanted, and then once', async () => {
    const { loads, applied, picture } = setup();
    expect(loads).toHaveLength(0);
    expect(picture.ready()).toBe(false);
    picture.want();
    picture.want();
    expect(loads).toHaveLength(1);
    const t = texture();
    loads[0]?.resolve(t);
    await Promise.resolve();
    expect(applied).toEqual([t]);
    expect(picture.ready()).toBe(true);
    picture.want();
    expect(loads).toHaveLength(1);
  });

  it('a picture that arrives after its layer went away is released, never shown', async () => {
    const { loads, applied, picture } = setup();
    picture.want();
    picture.dispose();
    const t = texture();
    loads[0]?.resolve(t);
    await Promise.resolve();
    expect(applied).toEqual([]);
    expect(t.disposed).toBe(1);
  });

  it('tries again on the next show after a load failed', async () => {
    const { loads, failed, picture } = setup();
    picture.want();
    loads[0]?.reject(new Error('gone'));
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toHaveLength(1);
    picture.want();
    expect(loads).toHaveLength(2);
  });
});

describe('a tiled raster on a lined-up date', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('places pyramid tiles with the date shift', async () => {
    // a 100 m square, one tile at the coarse level
    const index = {
      schema: 'aio.tiles/1',
      corners: { tl: [0, 0, -100], tr: [100, 0, -100], bl: [0, 0, 0] },
      levels: [{ z: 0, cols: 1, rows: 1, pattern: 'tiles/{z}/{x}/{y}.webp' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(index)))),
    );
    vi.spyOn(TextureLoader.prototype, 'loadAsync').mockResolvedValue(new Texture());
    const frames = new Set<(dt: number) => void>();
    const camera = new PerspectiveCamera(50, 1, 0.1, 5000);
    camera.position.set(50, 500, -50);
    camera.lookAt(50, 0, -50);
    camera.updateMatrixWorld();
    const scene: SceneHandle = {
      scene: new Scene(),
      camera,
      renderer: {
        capabilities: { maxTextureSize: 4096, getMaxAnisotropy: () => 1 },
      } as unknown as WebGLRenderer,
      projectId: 'p',
      requestRender: () => undefined,
      onFrame: (cb) => {
        frames.add(cb);
        return () => frames.delete(cb);
      },
      holdContinuous: () => () => undefined,
      projectionReceivers: () => [],
      raycast: () => null,
      raycastRay: () => null,
      addRaycastProvider: () => () => undefined,
      clippingPlanes: [] as Plane[],
      addRaycastTarget: () => () => undefined,
      addContentBounds: () => () => undefined,
      addProjectionReceiver: () => () => undefined,
    };
    const ctx: AdapterContext = {
      url: (r) => ('path' in r ? r.path : r.hash),
      scene,
      shiftOf: (id) => (id === 'ortho' ? { eastM: 2, northM: -1 } : null),
    };
    const layer: Extract<Layer, { kind: 'raster' }> = {
      kind: 'raster',
      id: 'ortho',
      name: 'Ortho',
      visible: true,
      role: 'ortho',
      format: 'kit-pyramid',
      src: { path: 'tiles/index.json' },
    };
    const handle = await rasterAdapter.create(layer, ctx);
    await new Promise((r) => setTimeout(r, 0));
    for (const f of frames) f(16);
    const group = scene.scene.getObjectByName('layer:ortho');
    const quads: Object3D[] = [];
    group?.traverse((o) => {
      if (o instanceof Mesh) quads.push(o as Object3D);
    });
    // the bounds quad and the coarse tile, both 2 m east and 1 m south
    expect(quads).toHaveLength(2);
    for (const q of quads) {
      const box = new Box3().setFromObject(q);
      expect(box.min.toArray()).toEqual([2, 0, -99]);
      expect(box.max.toArray()).toEqual([102, 0, 1]);
    }
    handle.dispose();
  });
});
