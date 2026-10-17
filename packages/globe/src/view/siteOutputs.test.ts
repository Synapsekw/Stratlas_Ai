import type { DateShift, Vec3 } from '@aio/schema';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { planGlobeLayers } from '../layers';
import type { PyramidIndex } from '../projectRasters';
import { SiteOutputLayers, type SiteOutputHost, type SiteOutputs } from './siteOutputs';

const INDEX: PyramidIndex = {
  levels: [{ z: 0, tileSize: 256, cols: 1, rows: 1, pattern: '{z}/{x}_{y}.png' }],
  corners: { tl: [0, 0, 0] as Vec3, tr: [1, 0, 0] as Vec3, bl: [0, 0, 1] as Vec3 },
};
const GEOREF = { crs: { epsg: 32640 }, origin: [412_000, 3_245_000, 20] as Vec3, heightOffset: 0 };

const raster = (layerId: string) => ({
  layerId,
  src: `rasters/${layerId}/tiles.json`,
  index: INDEX,
});
const site = (
  projectId: string,
  rasters: string[],
  tilesets: string[] = ['mesh'],
): SiteOutputs => ({
  projectId,
  georef: GEOREF,
  tilesets: tilesets.map((id) => ({ id, src: `tiles/${id}/tileset.json`, visible: true })),
  rasters: rasters.map(raster),
});

interface Tileset {
  projectId: string;
  id: string;
}
interface Provider {
  projectId: string;
  layerId: string;
  dispose: Mock<() => void>;
}
interface Layer {
  provider: Provider | string;
}

/** A fake imagery layer collection and primitives, as the controller's CesiumJS scene has them. */
function fakeScene() {
  const layers: Layer[] = [];
  const primitives: Tileset[] = [];
  const removeAll = vi.fn(() => {
    layers.length = 0;
  });
  const host: SiteOutputHost<Tileset, Layer, Provider> = {
    loadTilesets: (o, current) => {
      const loaded = o.tilesets.map((t) => ({ projectId: o.projectId, id: t.id }));
      return Promise.resolve().then(() => {
        if (!current()) return [];
        primitives.push(...loaded);
        return loaded;
      });
    },
    removeTileset: (t) => {
      primitives.splice(primitives.indexOf(t), 1);
    },
    createProvider: (o, r) => ({ projectId: o.projectId, layerId: r.layerId, dispose: vi.fn() }),
    disposeProvider: (p) => {
      p.dispose();
    },
    addLayer: (provider) => {
      const layer = { provider };
      layers.push(layer);
      return layer;
    },
    removeLayer: (layer) => {
      layers.splice(layers.indexOf(layer), 1);
    },
    raiseToTop: (layer) => {
      layers.splice(layers.indexOf(layer), 1);
      layers.push(layer);
    },
  };
  return { layers, primitives, removeAll, host };
}

const names = (layers: readonly Layer[]) =>
  layers.map((l) => (typeof l.provider === 'string' ? l.provider : l.provider.layerId));

describe('SiteOutputLayers', () => {
  it('hands the raster, with its date shift, to the provider and builds it again when the shift changes', async () => {
    const scene = fakeScene();
    const created: (DateShift | undefined)[] = [];
    const host = {
      ...scene.host,
      createProvider: (o: SiteOutputs, r: SiteOutputs['rasters'][number]) => {
        created.push(r.shift);
        return scene.host.createProvider(o, r);
      },
    };
    const outputs = new SiteOutputLayers(host);
    const shifted = (shift?: DateShift): SiteOutputs => ({
      ...site('A', ['ortho']),
      rasters: [{ ...raster('ortho'), ...(shift ? { shift } : {}) }],
    });
    await outputs.set([shifted({ eastM: 2, northM: 0 })]);
    const first = outputs.rasters()[0]?.provider;
    await outputs.set([shifted({ eastM: 2, northM: 0 })]);
    expect(outputs.rasters()[0]?.provider).toBe(first);
    await outputs.set([shifted({ eastM: 2.5, northM: 0 })]);
    expect(outputs.rasters()[0]?.provider).not.toBe(first);
    expect(first?.dispose).toHaveBeenCalledTimes(1);
    await outputs.set([shifted(undefined)]);
    expect(created).toEqual([{ eastM: 2, northM: 0 }, { eastM: 2.5, northM: 0 }, undefined]);
    expect(scene.layers).toHaveLength(1);
  });

  it('adds a heat map as one layer on top, keeping the ortho, with no removeAll', async () => {
    const scene = fakeScene();
    scene.layers.push({ provider: 'street' });
    const outputs = new SiteOutputLayers(scene.host);
    await outputs.set([site('A', ['ortho'])]);
    const ortho = scene.layers[1];
    expect(names(scene.layers)).toEqual(['street', 'ortho']);
    // something else lands on top meanwhile; the next set puts the rasters back over it
    scene.layers.push({ provider: 'other' });
    await outputs.set([site('A', ['ortho', 'heat'])]);
    expect(names(scene.layers)).toEqual(['street', 'other', 'ortho', 'heat']);
    expect(scene.layers[2]).toBe(ortho);
    expect(scene.removeAll).not.toHaveBeenCalled();
    // the tilesets were not loaded again
    expect(scene.primitives).toEqual([{ projectId: 'A', id: 'mesh' }]);
  });

  it('swaps B for C and keeps A as it was', async () => {
    const scene = fakeScene();
    const outputs = new SiteOutputLayers(scene.host);
    await outputs.set([site('A', ['a-ortho']), site('B', ['b-ortho'])]);
    const aLayer = scene.layers[0];
    const aTileset = scene.primitives[0];
    const bProvider = outputs.rasters().find((r) => r.projectId === 'B')?.provider;
    await outputs.set([site('A', ['a-ortho']), site('C', ['c-ortho'], ['c-mesh'])]);
    expect(names(scene.layers)).toEqual(['a-ortho', 'c-ortho']);
    expect(scene.layers[0]).toBe(aLayer);
    expect(scene.primitives).toEqual([
      { projectId: 'A', id: 'mesh' },
      { projectId: 'C', id: 'c-mesh' },
    ]);
    expect(scene.primitives[0]).toBe(aTileset);
    expect(bProvider?.dispose).toHaveBeenCalledTimes(1);
    expect(outputs.tilesets().map((t) => t.projectId)).toEqual(['A', 'C']);
  });

  it('drops a raster switched off, and its provider, without touching the tilesets', async () => {
    const scene = fakeScene();
    const outputs = new SiteOutputLayers(scene.host);
    await outputs.set([site('A', ['ortho', 'heat'])]);
    const heat = outputs.rasters().find((r) => r.layerId === 'heat')?.provider;
    const tileset = scene.primitives[0];
    await outputs.set([site('A', ['ortho'])]);
    expect(names(scene.layers)).toEqual(['ortho']);
    expect(heat?.dispose).toHaveBeenCalledTimes(1);
    expect(scene.primitives[0]).toBe(tileset);
  });

  it('re-adds the rasters on top after a plan rebuild, from the same providers', async () => {
    const scene = fakeScene();
    const outputs = new SiteOutputLayers(scene.host);
    await outputs.set([site('A', ['ortho', 'heat']), site('B', ['b-ortho'])]);
    const before = outputs.rasters().map((r) => r.provider);
    // the controller's rebuild of a look: the base anew, then the plan's project rasters
    scene.removeAll();
    const plan = planGlobeLayers({
      style: 'street',
      street: true,
      imagery: [],
      projectRasters: outputs.order(),
    });
    for (const entry of plan) {
      if (entry.kind === 'project-raster') outputs.readd(entry.raster);
      else scene.layers.push({ provider: entry.kind });
    }
    expect(names(scene.layers)).toEqual(['earth-shapes', 'street', 'ortho', 'heat', 'b-ortho']);
    expect(outputs.rasters().map((r) => r.provider)).toEqual(before);
    expect(outputs.rasters().map((r) => r.layer)).toEqual(scene.layers.slice(2));
  });

  it('lists every shown raster with its project and layer, in draw order', async () => {
    const scene = fakeScene();
    const outputs = new SiteOutputLayers(scene.host);
    await outputs.set([site('A', ['ortho', 'heat']), site('B', ['b-ortho'])]);
    expect(outputs.rasters().map(({ projectId, layerId }) => ({ projectId, layerId }))).toEqual([
      { projectId: 'A', layerId: 'ortho' },
      { projectId: 'A', layerId: 'heat' },
      { projectId: 'B', layerId: 'b-ortho' },
    ]);
    expect(outputs.order()).toEqual([
      { projectId: 'A', layerId: 'ortho' },
      { projectId: 'A', layerId: 'heat' },
      { projectId: 'B', layerId: 'b-ortho' },
    ]);
  });

  it('throws away tilesets that arrive for a project already gone', async () => {
    const scene = fakeScene();
    const outputs = new SiteOutputLayers(scene.host);
    const first = outputs.set([site('A', [])]);
    await outputs.set([]);
    await first;
    expect(scene.primitives).toEqual([]);
    expect(outputs.tilesets()).toEqual([]);
  });

  it('never destroys a tileset twice when the Globe is left while tilesets load', async () => {
    // tilesets as CesiumJS has them: a second destroy throws
    interface Destroyable {
      id: string;
      destroyed: boolean;
      isDestroyed(): boolean;
      destroy(): void;
    }
    const tileset = (id: string): Destroyable => ({
      id,
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      destroy() {
        if (this.destroyed) throw new Error('DeveloperError: This object was destroyed');
        this.destroyed = true;
      },
    });
    const primitives: Destroyable[] = [];
    let sceneGone = false;
    let arrive: () => void = () => undefined;
    const removeTileset = vi.fn((t: Destroyable) => {
      // the controller's host: skip what the scene's teardown destroyed already
      if (t.isDestroyed()) return;
      if (!sceneGone) primitives.splice(primitives.indexOf(t), 1);
      t.destroy();
    });
    const host: SiteOutputHost<Destroyable, Layer, Provider> = {
      ...fakeScene().host,
      loadTilesets: () =>
        new Promise((resolve) => {
          // added to the scene as it loads, handed back once the load ends
          const t = tileset('mesh');
          primitives.push(t);
          arrive = () => {
            resolve([t]);
          };
        }),
      removeTileset,
    };
    const outputs = new SiteOutputLayers(host);
    const pending = outputs.set([site('A', [])]);
    // leaving the Globe: the outputs go, then the widget destroys every primitive it holds
    outputs.dispose();
    sceneGone = true;
    for (const p of primitives) p.destroy();
    arrive();
    await expect(pending).resolves.toBeUndefined();
    expect(primitives.every((p) => p.destroyed)).toBe(true);
    // and the host's guard alone holds too: handed a destroyed tileset, it does nothing
    const [gone] = primitives;
    if (gone)
      expect(() => {
        host.removeTileset(gone);
      }).not.toThrow();
  });

  it('disposes every provider and removes everything on dispose', async () => {
    const scene = fakeScene();
    const outputs = new SiteOutputLayers(scene.host);
    await outputs.set([site('A', ['ortho']), site('B', ['b-ortho'])]);
    const providers = outputs.rasters().map((r) => r.provider);
    outputs.dispose();
    for (const p of providers) expect(p.dispose).toHaveBeenCalledTimes(1);
    expect(outputs.rasters()).toEqual([]);
  });
});
