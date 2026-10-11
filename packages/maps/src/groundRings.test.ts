// @vitest-environment jsdom
import type { AdapterContext } from '@aio/engine';
import type { Layer, ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { Scene, type Mesh } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroundRings } from './groundRings';
import type { GroundExtent } from './ground';

type Bounds = [[number, number], [number, number]];

/** MapLibre, as far as the rings go: it draws whatever bounds it was last given, a tick later. */
const fake = vi.hoisted(() => {
  const maps: { removed: boolean; fits: number }[] = [];
  class FakeMap {
    removed = false;
    fits = 0;
    private bounds: Bounds;
    private readonly canvas = document.createElement('canvas');
    constructor(o: { bounds: Bounds }) {
      this.bounds = o.bounds;
      maps.push(this);
    }
    once(_event: string, cb: () => void) {
      setTimeout(cb, 0);
    }
    fitBounds(b: Bounds) {
      this.bounds = b;
      this.fits++;
    }
    triggerRepaint() {
      // nothing to draw
    }
    getBounds() {
      const [[w, s], [e, n]] = this.bounds;
      return { getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n };
    }
    getCanvas() {
      return this.canvas;
    }
    remove() {
      this.removed = true;
    }
  }
  return { maps, FakeMap };
});
vi.mock('maplibre-gl', () => ({ Map: fake.FakeMap }));
vi.mock('./runtime', () => ({ installBasemap: vi.fn() }));

// jsdom has no 2D canvas: the copy of the picture is skipped
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const layer = {
  kind: 'basemap',
  id: 'site-street-map',
  name: 'Street map',
  visible: true,
  pack: 'auto',
  style: 'dark',
} as Extract<Layer, { kind: 'basemap' }>;
const square = (h: number): GroundExtent => ({ minX: -h, maxX: h, minZ: -h, maxZ: h });
const EXTENTS = [square(500), square(2000), square(8000)];

function context() {
  const scene = new Scene();
  const ctx = {
    url: () => '',
    scene: {
      scene,
      requestRender: vi.fn(),
      renderer: { capabilities: { getMaxAnisotropy: () => 1 } },
    },
  } as unknown as AdapterContext;
  return { scene, ctx };
}

beforeEach(() => {
  fake.maps.length = 0;
  (globalThis as { aio?: unknown }).aio = {
    invoke: vi.fn(() => Promise.resolve([{ id: 'pack', maxZoom: 14 }])),
  };
  workspace.getState().openProject({
    id: 'p',
    root: '/p',
    manifest: {
      crs: { epsg: 32639 },
      origin: [245747.13, 3179641.87, 0],
      layers: [],
    } as unknown as ProjectManifest,
  });
});

describe('street ground rings in the scene', () => {
  it('adds the near ring first, then each further ring as a frame, with one hidden map', async () => {
    const { scene, ctx } = context();
    const seen: number[] = [];
    const h = await createGroundRings(layer, ctx, {
      extents: EXTENTS,
      onRing: (mesh, i) => {
        seen.push(i);
        // the group is in the scene from the first ring on
        expect(scene.getObjectByName('basemap:site-street-map')).toBe(mesh.parent);
      },
    });
    expect(scene.getObjectByName('basemap:site-street-map')).toBeUndefined();
    await h.done;
    expect(seen).toEqual([0, 1, 2]);
    const rings = h.group.children as Mesh[];
    expect(rings.map((m) => m.geometry.getAttribute('position').count)).toEqual([4, 8, 8]);
    expect(fake.maps.length).toBe(1);
    expect(fake.maps[0]?.fits).toBe(2);
    expect(fake.maps[0]?.removed).toBe(true);
    expect(document.body.children.length).toBe(0);
  });

  it('hides and shows every ring together', async () => {
    const { ctx } = context();
    const h = await createGroundRings(layer, ctx, { extents: EXTENTS });
    await h.done;
    h.setVisible(false);
    expect(h.group.visible).toBe(false);
    h.setVisible(true);
    expect(h.group.visible).toBe(true);
  });

  it('stops when disposed while drawing, and frees what it drew', async () => {
    const { scene, ctx } = context();
    const seen: number[] = [];
    const h = await createGroundRings(layer, ctx, {
      extents: EXTENTS,
      onRing: (_mesh, i) => {
        seen.push(i);
        if (i === 0) h.dispose();
      },
    });
    await h.done;
    expect(seen).toEqual([0]);
    expect(scene.getObjectByName('basemap:site-street-map')).toBeUndefined();
    expect(h.group.children.length).toBe(0);
    expect(fake.maps[0]?.removed).toBe(true);
    expect(document.body.children.length).toBe(0);
  });

  it('draws nothing without extents', async () => {
    const { scene, ctx } = context();
    const h = await createGroundRings(layer, ctx, { extents: [] });
    await h.done;
    expect(scene.children.length).toBe(0);
    expect(fake.maps.length).toBe(0);
  });
});
