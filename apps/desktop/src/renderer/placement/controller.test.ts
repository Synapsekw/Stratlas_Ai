import { cameraSources, imageSizeOf, type PlaceScene } from '@aio/annotate';
import type { SceneHandle } from '@aio/engine';
import type { Issue, Layer, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { ensureSizes, layerReady, placeOnScene } from './controller';

const manifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32640 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [{ id: 'P9', src: { path: 'photos/P9.jpg' } }],
    },
    {
      kind: 'pointcloud',
      id: 'cloud',
      name: 'Cloud',
      visible: false,
      src: { path: 'c.json' },
      format: 'png-packed',
    },
  ],
  severityModels: [],
  classCatalogues: [],
} as unknown as ProjectManifest;
const onP9 = {
  sightings: [
    { on: 'image', layer: 'photos', photo: 'P9', geom: { type: 'box', x: 0, y: 0, w: 5, h: 5 } },
  ],
} as unknown as Issue;

describe('ensureSizes', () => {
  it('learns the size of a photo no viewer has shown, once', async () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: 'r', manifest }, []);
    const probe = vi.fn(() => Promise.resolve([4000, 3000] as [number, number]));
    expect(imageSizeOf('photos', 'P9')).toBeNull();
    await ensureSizes(ws, onP9, probe);
    expect(imageSizeOf('photos', 'P9')).toEqual([4000, 3000]);
    expect(probe).toHaveBeenCalledWith('aio://project/p/photos/P9.jpg');
    await ensureSizes(ws, onP9, probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('layerReady', () => {
  it('shows a hidden layer and waits until the 3D view can cast at it', async () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: 'r', manifest }, []);
    expect(ws.getState().hidden.cloud).toBe(true);
    let loaded = false;
    const scene = () =>
      ({ rayLayers: () => new Set(loaded ? ['cloud'] : []) }) as unknown as SceneHandle;
    setTimeout(() => {
      loaded = true;
    }, 20);
    expect(await layerReady(ws, 'cloud', scene, 1000, 5)).toBe(true);
    expect(ws.getState().hidden.cloud).toBeUndefined();
  });

  it('gives up when the layer never loads or there is no 3D view', async () => {
    const ws = createWorkspace();
    ws.getState().openProject({ id: 'p', root: 'r', manifest }, []);
    expect(await layerReady(ws, 'cloud', () => null, 30, 5)).toBe(false);
  });
});

describe('placeOnScene', () => {
  const handle = {
    raycastRay: () => null,
    rayLayers: () => new Set(['cloud']),
  } as unknown as SceneHandle;
  const cloud = {
    kind: 'pointcloud',
    id: 'cloud',
    name: 'Cloud',
    visible: true,
    src: { path: 'c.json' },
    format: 'png-packed',
  } as unknown as Layer;
  const focus = { eye: [0, 0, 0] as [number, number, number], planes: [], pxPerM: 1000 };

  it('hands the refine hold back when the projection throws after taking it', async () => {
    const release = vi.fn();
    const refine = vi.fn(() => Promise.resolve({ depth: 4, settled: false, release }));
    const run = async (_i: Issue, _l: Layer, scene: PlaceScene) => {
      await scene.cloud?.refineAround(focus, 3000);
      throw new Error('boom');
    };
    await expect(placeOnScene(onP9, cloud, handle, cameraSources, run, refine)).rejects.toThrow(
      'boom',
    );
    expect(refine).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases a hold the projection kept, and not again one it released', async () => {
    const kept = vi.fn();
    const given = vi.fn();
    const holds = [kept, given];
    const refine = vi.fn(() =>
      Promise.resolve({ depth: 2, settled: true, release: holds.shift() ?? (() => undefined) }),
    );
    const run = async (_i: Issue, _l: Layer, scene: PlaceScene) => {
      await scene.cloud?.refineAround(focus, 3000);
      const second = await scene.cloud?.refineAround(focus, 3000);
      second?.release();
      return { ok: false as const, reason: 'missed' as const };
    };
    expect(await placeOnScene(onP9, cloud, handle, cameraSources, run, refine)).toEqual({
      ok: false,
      reason: 'missed',
    });
    expect(kept).toHaveBeenCalledTimes(1);
    expect(given).toHaveBeenCalledTimes(1);
  });
});
