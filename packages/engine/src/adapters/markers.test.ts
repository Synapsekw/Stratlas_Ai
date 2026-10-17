// @vitest-environment jsdom
import { PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneHandle } from '../types';
import {
  MarkerLayer,
  markersHit,
  sceneMarkerView,
  type MarkerSite,
  type MarkerView,
} from './markers';

/** A view whose points project to fixed screen spots (x, z of the site are its pixels). */
function fakeView() {
  const host = document.createElement('div');
  const surface = document.createElement('div');
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
  host.append(surface);
  document.body.append(host);
  const frames = new Set<() => void>();
  const claimed: PointerEvent[] = [];
  const view: MarkerView = {
    host,
    surface,
    project: (p) => ({ x: p[0], y: p[2] }),
    onFrame: (cb) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
    claimClick: (e) => claimed.push(e),
  };
  const frame = () => {
    for (const f of frames) f();
  };
  return { host, surface, view, frame, claimed, frames };
}

const click = (el: HTMLElement, x: number, y: number, mods: PointerEventInit = {}) => {
  el.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, ...mods }));
  el.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, button: 0, ...mods }));
};

const icons = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('.aio-mk')].filter((e) => e.style.display !== 'none');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MarkerLayer on a MarkerView', () => {
  const sites: MarkerSite[] = [
    { pos: [100, 0, 100], members: [0] },
    { pos: [300, 0, 200], members: [1] },
  ];
  const members = [
    { id: 'a', thumb: 'aio://thumb/p/a.jpg', full: 'aio://project/p/a.jpg' },
    { id: 'b', takenAt: '2026-01-01T10:00:00Z' },
  ];

  it('lays out one plate per site, opens a clicked one and claims the click', () => {
    const { host, surface, view, frame, claimed } = fakeView();
    const open = vi.fn();
    const layer = new MarkerLayer({
      view,
      kind: 'photo',
      sites,
      member: (i) => members[i] ?? { id: '' },
      open,
      selected: () => new Set(),
    });
    frame();
    expect(icons(host).map((e) => e.dataset.kind)).toEqual(['photo', 'photo']);
    expect(host.querySelector('[data-markers=photo]')).not.toBeNull();

    // away from the plates: nothing
    click(surface, 200, 30);
    expect(open).not.toHaveBeenCalled();
    expect(claimed).toHaveLength(0);

    // 10 px off the second plate's centre is still on it (a 28 px target)
    click(surface, 310, 200);
    expect(open).toHaveBeenCalledWith(1, { split: true });
    expect(claimed).toHaveLength(1);

    // a modified click selects only
    click(surface, 100, 100, { ctrlKey: true });
    expect(open).toHaveBeenLastCalledWith(0, { split: false });

    expect(layer.memberAt(102, 98)).toEqual({ index: 0 });
    expect(layer.memberAt(200, 30)).toBeNull();
    layer.dispose();
    expect(host.querySelector('[data-markers=photo]')).toBeNull();
  });

  it('tells whether a point is on any marker over a surface', () => {
    const { surface, view, frame } = fakeView();
    expect(markersHit(surface, 100, 100)).toBe(false);
    const layer = new MarkerLayer({
      view,
      kind: 'pano',
      sites,
      member: (i) => members[i] ?? { id: '' },
      open: () => undefined,
      selected: () => new Set(),
    });
    frame();
    expect(markersHit(surface, 104, 98)).toBe(true);
    expect(markersHit(surface, 200, 30)).toBe(false);
    layer.dispose();
    expect(markersHit(surface, 104, 98)).toBe(false);
  });

  it('shows the thumbnail of a single photo in its hover tip', async () => {
    const { host, surface, view, frame } = fakeView();
    const layer = new MarkerLayer({
      view,
      kind: 'photo',
      sites,
      member: (i) => members[i] ?? { id: '' },
      open: () => undefined,
      selected: () => new Set(),
    });
    frame();
    surface.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 101, clientY: 99, pointerType: 'mouse' }),
    );
    await new Promise((r) => requestAnimationFrame(r));
    frame();
    const tip = host.querySelector<HTMLElement>('.aio-mk-tip');
    expect(tip?.style.display).toBe('');
    expect(tip?.querySelector('img')?.getAttribute('src')).toBe('aio://thumb/p/a.jpg');
    expect(surface.style.cursor).toBe('pointer');
    layer.dispose();
  });

  it('leaves a 3D click on a marker to an armed pick (the pane is picking)', () => {
    const pane = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 }) as DOMRect;
    pane.append(canvas);
    document.body.append(pane);
    const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const frames = new Set<(dt: number) => void>();
    const scene = {
      camera,
      renderer: { domElement: canvas },
      requestRender: () => undefined,
      onFrame: (cb: (dt: number) => void) => {
        frames.add(cb);
        return () => frames.delete(cb);
      },
    } as unknown as SceneHandle;
    const open = vi.fn();
    const layer = new MarkerLayer({
      view: sceneMarkerView(scene),
      kind: 'pano',
      sites: [{ pos: [0, 0, 0], members: [0] }],
      member: () => ({ id: 'a' }),
      open,
      selected: () => new Set(),
    });
    for (const f of frames) f(16);
    pane.dataset.picking = 'true';
    click(canvas, 100, 100);
    expect(open).not.toHaveBeenCalled();
    delete pane.dataset.picking;
    click(canvas, 100, 100);
    expect(open).toHaveBeenCalledWith(0, { split: true });
    layer.dispose();
  });

  it('takes no clicks while the view is busy with another tool', () => {
    const { surface, view, frame } = fakeView();
    let busy = true;
    const open = vi.fn();
    const layer = new MarkerLayer({
      view: { ...view, busy: () => busy },
      kind: 'pano',
      sites,
      member: (i) => members[i] ?? { id: '' },
      open,
      selected: () => new Set(),
    });
    frame();
    click(surface, 100, 100);
    expect(open).not.toHaveBeenCalled();
    busy = false;
    click(surface, 100, 100);
    expect(open).toHaveBeenCalledWith(0, { split: true });
    layer.dispose();
  });
});
