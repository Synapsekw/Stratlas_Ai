// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { PerspectiveCamera, Scene, Sprite, Vector3, type Plane, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { SceneHandle } from '../types';
import { createPanoramasAdapter, hudTopInset } from './panoramas';

type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;

const layer: PanoLayer = {
  kind: 'panoramas',
  id: 'panos',
  name: 'Panoramas',
  visible: true,
  items: [
    // straight ahead of the camera, 40 m up
    { id: 'a', src: { path: 'panoramas/a.jpg' }, pos: [0, 40, -100], headingDeg: 90 },
    { id: 'b', src: { path: 'panoramas/b.jpg' }, pos: [300, 40, -100], headingDeg: 0 },
  ],
};

function setup() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
  host.append(canvas);
  const overlay = document.createElement('div');
  overlay.className = 'aio-stage-overlay';
  host.append(overlay);
  document.body.append(host);
  const camera = new PerspectiveCamera(50, 1, 0.1, 5000);
  camera.position.set(0, 40, 200);
  camera.lookAt(0, 40, -100);
  camera.updateMatrixWorld();
  const frames = new Set<(dt: number) => void>();
  const h: SceneHandle = {
    scene: new Scene(),
    camera,
    renderer: { domElement: canvas } as unknown as WebGLRenderer,
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
    addProjectionReceiver: () => () => undefined,
  };
  return { host, canvas, overlay, camera, h, frames };
}

const click = (canvas: HTMLCanvasElement, x: number, y: number) => {
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0 }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, button: 0 }));
};

describe('panoramas layer', () => {
  it('draws a marker per panorama, enters the clicked one and returns on Esc', async () => {
    const { host, canvas, overlay, camera, h, frames } = setup();
    const store = createWorkspace();
    const lh = await createPanoramasAdapter(store).create(layer, {
      url: (r) => `aio://project/p/${'path' in r ? r.path : r.hash}`,
      scene: h,
    });
    const group = h.scene.getObjectByName('panoramas:panos');
    const markers = group?.children.filter((c): c is Sprite => c instanceof Sprite) ?? [];
    expect(markers.map((m) => m.name)).toEqual(['pano:a', 'pano:b']);

    // a click away from the markers does nothing
    click(canvas, 10, 10);
    expect(store.getState().selection).toBeNull();

    click(canvas, 100, 100);
    expect(store.getState().selection).toEqual({ kind: 'pano', id: 'a', layer: 'panos' });
    expect(camera.position.toArray()).toEqual([0, 40, -100]);
    // looking along the panorama heading (east), a little down
    const fwd = camera.getWorldDirection(new Vector3());
    expect(fwd.x).toBeGreaterThan(0.9);
    expect(fwd.y).toBeLessThan(0);
    expect(camera.layers.mask).toBe(2 ** 31);
    expect(host.querySelector('.aio-pano-hud')).not.toBeNull();
    expect(overlay.style.visibility).toBe('hidden');
    // the stage's frame loop cannot move the camera away from the panorama
    camera.position.set(5, 5, 5);
    for (const f of frames) f(16);
    expect(camera.position.toArray()).toEqual([0, 40, -100]);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(camera.position.toArray()).toEqual([0, 40, 200]);
    expect(camera.fov).toBe(50);
    expect(camera.layers.mask).toBe(1);
    expect(host.querySelector('.aio-pano-hud')).toBeNull();
    expect(overlay.style.visibility).toBe('');
    expect(frames.size).toBe(0);

    // selecting something else leaves the immersive view too
    click(canvas, 100, 100);
    expect(camera.layers.mask).toBe(2 ** 31);
    store.getState().select(null);
    expect(camera.position.toArray()).toEqual([0, 40, 200]);

    lh.dispose();
    expect(h.scene.getObjectByName('panoramas:panos')).toBeUndefined();
    host.remove();
  });

  it('leaves the immersive view when the layer is hidden', async () => {
    const { host, canvas, camera, h } = setup();
    const store = createWorkspace();
    const lh = await createPanoramasAdapter(store).create(layer, { url: () => '', scene: h });
    click(canvas, 100, 100);
    expect(camera.layers.mask).toBe(2 ** 31);
    lh.setVisible(false);
    expect(camera.layers.mask).toBe(1);
    expect(host.querySelector('.aio-pano-hud')).toBeNull();
    // hidden markers cannot be clicked
    click(canvas, 100, 100);
    expect(camera.layers.mask).toBe(1);
    lh.dispose();
    host.remove();
  });

  it('keeps the HUD below the app toolbars, not above the video window', () => {
    const stage = { top: 40, height: 700 };
    const toolbar = { top: 55, bottom: 85 };
    const pill = { top: 97, bottom: 117 };
    const videoWindow = { top: 467, bottom: 720 };
    expect(hudTopInset(stage, [toolbar, pill, videoWindow])).toBe(85);
    expect(hudTopInset(stage, [])).toBe(12);
  });
});
