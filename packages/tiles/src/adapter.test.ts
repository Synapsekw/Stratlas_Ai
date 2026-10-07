import type { SceneHandle } from '@aio/engine';
import type { TilesetEntry } from '@aio/schema';
import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Plane,
  Scene,
  Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { attachTileset, defaultTiles, groupMatrix, type TilesLike } from './adapter';
import { TILES_BUDGETS } from './budgets';
import { applyM4, siteFrame, type V3 } from './frame';

const manifest = { crs: { epsg: 32639 }, origin: [500_000, 3_200_000, 12] as V3 };
const frame = siteFrame(manifest);
if (!frame) throw new Error('no frame');

const entry = (over: Partial<TilesetEntry> = {}): TilesetEntry => ({
  id: 'mesh-tiles',
  name: 'Mesh',
  kind: 'mesh',
  src: 'tiles/mesh-tiles/tileset.json',
  visible: true,
  ...over,
});

class FakeTiles implements TilesLike {
  group = new Group();
  errorTarget = 16;
  lruCache = { maxBytesSize: 0, minBytesSize: 0 };
  loadProgress = 0.5;
  plugins: object[] = [];
  listeners = new Map<string, ((e: { scene?: Object3D }) => void)[]>();
  updates = 0;
  disposed = false;
  camera: unknown = null;
  setCamera(c: unknown) {
    this.camera = c;
    return true;
  }
  setResolutionFromRenderer() {
    return true;
  }
  registerPlugin(p: object) {
    this.plugins.push(p);
  }
  addEventListener(name: string, cb: (e: { scene?: Object3D }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
  }
  update() {
    this.updates += 1;
  }
  dispose() {
    this.disposed = true;
  }
  /** Load a tile as 3DTilesRendererJS does: matrix = tile transform, then the plugins. */
  async load(model: Object3D, tile: object) {
    for (const p of this.plugins as {
      processTileModel?: (m: Object3D, t: object) => Promise<void>;
    }[])
      await p.processTileModel?.(model, tile);
    this.group.add(model);
    for (const cb of this.listeners.get('load-model') ?? []) cb({ scene: model });
  }
}

function fakeScene() {
  const frames: ((dt: number) => void)[] = [];
  const targets = new Map<Object3D, string>();
  const scene: SceneHandle = {
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    renderer: {} as SceneHandle['renderer'],
    projectId: 'p',
    requestRender: vi.fn(),
    onFrame: (cb) => {
      frames.push(cb);
      return () => frames.splice(frames.indexOf(cb), 1);
    },
    holdContinuous: () => () => undefined,
    projectionReceivers: () => [],
    raycast: () => null,
    raycastRay: () => null,
    addRaycastProvider: () => () => undefined,
    clippingPlanes: [new Plane(new Vector3(1, 0, 0), 5)],
    addRaycastTarget: (o, id) => {
      targets.set(o, id);
      return () => targets.delete(o);
    },
    addProjectionReceiver: () => () => undefined,
  };
  return { scene, frames, targets };
}

describe('the tileset adapter (3DTilesRendererJS in the site view)', () => {
  it('adds the tileset to the scene with the tier budget, picking and per-frame updates', () => {
    const { scene, frames, targets } = fakeScene();
    const fake = new FakeTiles();
    const h = attachTileset(scene, {
      url: 'aio://project/p/tiles/mesh-tiles/tileset.json',
      entry: entry({ from: 'mesh-1' }),
      frame,
      budget: TILES_BUDGETS.medium,
      create: () => fake,
    });
    expect(scene.scene.children).toContain(fake.group);
    expect(fake.errorTarget).toBe(TILES_BUDGETS.medium.errorTarget);
    expect(fake.lruCache.maxBytesSize).toBe(TILES_BUDGETS.medium.maxBytes);
    expect(fake.camera).toBe(scene.camera);
    expect(targets.get(fake.group)).toBe('mesh-1');
    expect(h.pickId).toBe('mesh-1');
    for (const f of frames) f(16);
    expect(fake.updates).toBe(1);
    h.setBudget(TILES_BUDGETS.low);
    expect(fake.errorTarget).toBe(TILES_BUDGETS.low.errorTarget);
    h.setVisible(false);
    for (const f of frames) f(16);
    expect(fake.updates).toBe(1);
    h.dispose();
    expect(fake.disposed).toBe(true);
    expect(scene.scene.children).not.toContain(fake.group);
    expect(targets.size).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('places each loaded tile through the CRS within a millimetre, cut by the section planes', async () => {
    const { scene } = fakeScene();
    const fake = new FakeTiles();
    attachTileset(scene, {
      url: 'x',
      entry: entry(),
      frame,
      budget: TILES_BUDGETS.high,
      create: () => fake,
    });
    expect(fake.group.matrixAutoUpdate).toBe(false);
    // A leaf tile 1.6 km from the origin, written as the pipelines do: content in the east-north-up
    // frame of the origin (root transform to ECEF), glTF y-up turned to z-up by the renderer.
    const o = frame.localToEcef([0, 0, 0]);
    const up = new Vector3(...o).normalize();
    const east = new Vector3(0, 0, 1).cross(up).normalize();
    const north = up.clone().cross(east);
    const root = new Matrix4().makeBasis(east, north, up).setPosition(...o);
    const target: V3 = [1100, 4, -1200];
    const ecef = frame.localToEcef(target);
    const enu = new Vector3(...ecef).applyMatrix4(root.clone().invert());
    const model = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    model.matrix.copy(root);
    model.matrix.decompose(model.position, model.quaternion, model.scale);
    const tile = {
      boundingVolume: { box: [enu.x, enu.y, enu.z, 50, 0, 0, 0, 50, 0, 0, 0, 10] },
      engineData: { transform: root },
    };
    await fake.load(model, tile);
    model.updateMatrixWorld(true);
    const world = new Vector3(enu.x, enu.y, enu.z).applyMatrix4(model.matrixWorld);
    expect(world.distanceTo(new Vector3(...target))).toBeLessThan(1e-3);
    const mat = model.material;
    expect(mat.clippingPlanes).toBe(scene.clippingPlanes);
    expect(model.userData.layerId).toBe('tileset:mesh-tiles');
  });

  it('uses an imported tileset its own placement, and the identity without a CRS', () => {
    const t = new Matrix4().makeTranslation(10, 0, -5).toArray();
    expect(groupMatrix(entry({ kind: 'imported', transform: t }), frame)).toEqual(t);
    expect(groupMatrix(entry(), null)).toEqual(new Matrix4().toArray());
    const g = groupMatrix(entry(), frame);
    const p = applyM4(g, frame.localToEcef([0, 0, 0]));
    expect(Math.hypot(...p)).toBeLessThan(1e-6);
  });

  it('builds a real TilesRenderer offline (no request until it updates)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const tiles = defaultTiles('aio://project/p/tiles/x/tileset.json');
    expect(tiles.group).toBeInstanceOf(Object3D);
    expect(fetchSpy).not.toHaveBeenCalled();
    tiles.dispose();
    fetchSpy.mockRestore();
  });
});
