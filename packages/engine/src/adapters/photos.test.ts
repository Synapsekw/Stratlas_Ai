// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import type { InstancedMesh } from 'three';
import { PerspectiveCamera, Scene, Vector3, type Plane, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneHandle } from '../types';
import {
  createPhotosAdapter,
  frustumDepth,
  imageHalfExtents,
  needsPins,
  photoMatrix,
  photoStations,
  posedPhotos,
} from './photos';

type PhotosLayer = Extract<Layer, { kind: 'photos' }>;

const layer: PhotosLayer = {
  kind: 'photos',
  id: 'photos',
  name: 'Photos',
  visible: true,
  items: [
    // looking north (-Z) from 2 m up
    { id: 'p1', src: { path: 'photos/p1.jpg' }, pos: [0, 2, 0], q: [0, 0, 0, 1] },
    { id: 'p2', src: { path: 'photos/p2.jpg' }, pos: [1, 2, 0], q: [0, 0, 0, 1] },
    { id: 'p3', src: { path: 'photos/p3.jpg' }, pos: [2, 2, 0], q: [0, 0, 0, 1] },
    { id: 'unposed', src: { path: 'photos/u.jpg' } },
  ],
};

function handle(canvas: HTMLCanvasElement): SceneHandle {
  const camera = new PerspectiveCamera(50, 1, 0.01, 100);
  camera.position.set(1, 2, 5);
  camera.lookAt(1, 2, 0);
  camera.updateMatrixWorld();
  return {
    scene: new Scene(),
    camera,
    renderer: { domElement: canvas } as unknown as WebGLRenderer,
    projectId: 'p',
    requestRender: () => undefined,
    onFrame: () => () => undefined,
    holdContinuous: () => () => undefined,
    projectionReceivers: () => [],
    raycast: () => null,
    raycastRay: () => null,
    addRaycastProvider: () => () => undefined,
    clippingPlanes: [] as Plane[],
    addRaycastTarget: () => () => undefined,
    addProjectionReceiver: () => () => undefined,
  };
}

describe('photo frustums', () => {
  it('draws only posed photos, sized to their spacing', () => {
    expect(posedPhotos(layer.items).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(frustumDepth([[0, 0, 0]])).toBe(1);
    expect(
      frustumDepth([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
    ).toBeCloseTo(0.6);
    // clamped for very dense or very sparse sets
    expect(
      frustumDepth([
        [0, 0, 0],
        [0.01, 0, 0],
      ]),
    ).toBe(0.08);
    expect(
      frustumDepth([
        [0, 0, 0],
        [500, 0, 0],
      ]),
    ).toBe(20);
  });

  it('sizes frustums to the spread of a site, not to bursts taken from one hover point', () => {
    // Al-Zour: a few photos at a time from one hover point (5 cm apart), stations ~500 m apart.
    const burst = (x: number, z: number): [number, number, number][] => [
      [x, 150, z],
      [x + 0.05, 150, z],
      [x + 0.1, 150, z + 0.05],
    ];
    const site = [
      ...burst(-450, -150),
      ...burst(350, -140),
      ...burst(-880, -310),
      ...burst(880, 220),
    ];
    expect(frustumDepth(site)).toBeGreaterThan(10);
    // a dense set inside one asset keeps its spacing-based size
    const ring = Array.from({ length: 120 }, (_, i): [number, number, number] => {
      const a = (i / 120) * Math.PI * 2;
      return [5 * Math.cos(a), 3, 5 * Math.sin(a)];
    });
    expect(frustumDepth(ring)).toBeCloseTo(0.6 * 2 * 5 * Math.sin(Math.PI / 120), 3);
  });

  it('groups photos taken from one point into a station', () => {
    const stations = photoStations(
      [
        { pos: [0, 100, 0] },
        { pos: [0.05, 100, 0] },
        { pos: [400, 30, 0] },
        { pos: [0.1, 100.1, 0] },
      ],
      10,
    );
    expect(stations.map((s) => s.photos)).toEqual([[0, 1, 3], [2]]);
    expect(stations[0]?.pos).toEqual([0, 100, 0]);
  });

  it('pins photos that are lost at site scale, not a dense set inside an asset', () => {
    const far = photoStations(
      [{ pos: [-450, 150, -150] }, { pos: [350, 30, -140] }, { pos: [-880, 120, -310] }],
      15,
    );
    expect(needsPins(far, 15)).toBe(true);
    const ring = Array.from({ length: 120 }, (_, i) => {
      const a = (i / 120) * Math.PI * 2;
      return { pos: [5 * Math.cos(a), 3, 5 * Math.sin(a)] as [number, number, number] };
    });
    const depth = frustumDepth(ring.map((r) => r.pos));
    expect(needsPins(photoStations(ring, depth), depth)).toBe(false);
  });

  it('widens the image with the lens and caps fisheyes', () => {
    const [hx, hy] = imageHalfExtents({ model: 'pinhole', hfovDeg: 90, aspect: 2 });
    expect(hx).toBeCloseTo(1);
    expect(hy).toBeCloseTo(0.5);
    expect(imageHalfExtents({ model: 'ftheta', hfovDeg: 180, aspect: 1 })[0]).toBeCloseTo(
      Math.tan((50 * Math.PI) / 180),
    );
  });

  it('places the frustum at the photo pose, looking down -Z', () => {
    const [p] = posedPhotos(layer.items);
    if (!p) throw new Error('no photo');
    const tip = new Vector3(0, 0, -1).applyMatrix4(photoMatrix(p, 0.5));
    expect(tip.toArray()).toEqual([0, 2, -0.5]);
  });

  it('selects the clicked photo and paints it in the accent colour', async () => {
    const store = createWorkspace();
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
    const h = handle(canvas);
    const adapter = createPhotosAdapter(store);
    const lh = await adapter.create(layer, { url: () => '', scene: h });
    const planes = h.scene.getObjectByName('photos:photos')?.children[2] as InstancedMesh;
    expect(planes.count).toBe(3);
    // the middle photo sits straight ahead of the camera
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0 }),
    );
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, button: 0 }));
    expect(store.getState().selection).toEqual({ kind: 'photo', id: 'p2', layer: 'photos' });
    // a drag is not a click
    store.getState().select(null);
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0 }),
    );
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 140, clientY: 100, button: 0 }));
    expect(store.getState().selection).toBeNull();
    lh.dispose();
    expect(h.scene.getObjectByName('photos:photos')).toBeUndefined();
  });

  it('pins site-scale photos, including ones with a position only, and selects on a pin click', async () => {
    const site: PhotosLayer = {
      kind: 'photos',
      id: 'site',
      name: 'Drone photos',
      visible: true,
      items: [
        { id: 'a1', src: { path: 'photos/a1.jpg' }, pos: [0, 2, 0], q: [0, 0, 0, 1] },
        { id: 'a2', src: { path: 'photos/a2.jpg' }, pos: [0.05, 2, 0], q: [0, 0, 0, 1] },
        { id: 'b', src: { path: 'photos/b.jpg' }, pos: [600, 120, -300], q: [0, 0, 0, 1] },
        { id: 'c', src: { path: 'photos/c.jpg' }, pos: [-700, 90, 400] },
        { id: 'nowhere', src: { path: 'photos/n.jpg' } },
      ],
    };
    const store = createWorkspace();
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
    const h = handle(canvas);
    h.camera.position.set(0, 2, 50);
    h.camera.lookAt(0, 2, 0);
    h.camera.updateMatrixWorld();
    const lh = await createPhotosAdapter(store).create(site, { url: () => '', scene: h });
    const group = h.scene.getObjectByName('photos:site');
    const pins = group?.children.filter((o) => o.name.startsWith('photo-pin:')) ?? [];
    // one pin per station: a1 and a2 share theirs; c has no orientation but still has a place
    expect(pins.map((p) => p.name)).toEqual(['photo-pin:a1', 'photo-pin:b', 'photo-pin:c']);
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', { clientX: 100, clientY: 100, button: 0 }),
    );
    canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, button: 0 }));
    expect(store.getState().selection).toEqual({ kind: 'photo', id: 'a1', layer: 'site' });
    lh.dispose();
  });
});
