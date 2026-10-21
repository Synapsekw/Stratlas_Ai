// @vitest-environment jsdom
import type { Layer } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameProjection } from './geo';
import { MapMediaMarkers, setMapPanoOpenHandler } from './mediaMarkers';
import { setPhotoMapClickHandler } from './photoPins';

/** A map whose screen point of a local spot is (x, z): toLonLat gives [x, z], project keeps it. */
function fakeMap() {
  const container = document.createElement('div');
  const canvasContainer = document.createElement('div');
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
  canvasContainer.append(canvas);
  container.append(canvasContainer);
  document.body.append(container);
  const renders = new Set<() => void>();
  const map = {
    getContainer: () => container,
    getCanvasContainer: () => canvasContainer,
    getCanvas: () => canvas,
    project: (ll: [number, number]) => ({ x: ll[0], y: ll[1] }),
    getCenter: () => ({ lng: 0, lat: 0 }),
    getZoom: () => 18,
    getBearing: () => 0,
    getPitch: () => 0,
    on: (type: string, cb: () => void) => {
      if (type === 'render') renders.add(cb);
    },
    off: (type: string, cb: () => void) => {
      if (type === 'render') renders.delete(cb);
    },
    triggerRepaint: () => {
      for (const r of renders) r();
    },
  };
  const proj: FrameProjection = {
    toLonLat: (p) => [p[0], p[2]],
    toLocal: (lon, lat) => [lon, 0, lat],
  };
  return { map: map as unknown as MapLibreMap, container, canvasContainer, canvas, proj, renders };
}

const layers: Layer[] = [
  {
    kind: 'photos',
    id: 'ph',
    name: 'Photos',
    visible: true,
    items: [
      { id: 'gps', src: { path: 'photos/gps.jpg' }, pos: [100, 30, 100] },
      {
        id: 'pinned',
        src: { path: 'photos/pinned.jpg' },
        pos: [200, 1.6, 100],
        pin: { ground: [200, 0, 100], eyeM: 1.6 },
      },
      { id: 'loose', src: { path: 'photos/loose.jpg' } },
    ],
  },
  {
    kind: 'panoramas',
    id: 'pa',
    name: 'Panoramas',
    visible: true,
    items: [
      { id: 'sphere', src: { path: 'panoramas/sphere.jpg' }, pos: [300, 1.6, 200], headingDeg: 0 },
      { id: 'unplaced', src: { path: 'panoramas/unplaced.jpg' }, headingDeg: 0 },
    ],
  },
];

function state(hidden: Record<string, true> = {}) {
  const select = vi.fn();
  const openPano = vi.fn();
  const s = {
    project: { id: 'p', manifest: { layers, captures: [] } },
    hidden,
    orientation: null,
    selection: null,
    select,
    openPano,
  } as unknown as Workspace;
  return { s, select, openPano };
}

const url = (r: { path?: string; hash?: string }) => `aio://project/p/${r.path ?? r.hash ?? ''}`;

const click = (el: HTMLElement, x: number, y: number, mods: PointerEventInit = {}) => {
  el.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, ...mods }));
  el.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, button: 0, ...mods }));
};

const shown = (root: HTMLElement, kind: string) =>
  [...root.querySelectorAll<HTMLElement>(`[data-markers=${kind}] .aio-mk`)].filter(
    (e) => e.style.display !== 'none',
  );

afterEach(() => {
  setPhotoMapClickHandler(null);
  setMapPanoOpenHandler(null);
  document.body.innerHTML = '';
});

describe('MapMediaMarkers', () => {
  it('draws placed photos and 360s, none for unplaced items or hidden layers', () => {
    const { map, container, proj } = fakeMap();
    const m = new MapMediaMarkers({ map, proj, url });
    m.update(state().s);
    expect(shown(container, 'photo')).toHaveLength(2);
    expect(shown(container, 'pano')).toHaveLength(1);
    m.update(state({ ph: true, pa: true }).s);
    expect(shown(container, 'photo')).toHaveLength(0);
    expect(shown(container, 'pano')).toHaveLength(0);
    m.dispose();
    expect(container.querySelector('[data-markers]')).toBeNull();
  });

  it('opens a clicked photo beside the map, and a clicked 360', () => {
    const { map, canvas, canvasContainer, proj } = fakeMap();
    const photo = vi.fn();
    const pano = vi.fn();
    setPhotoMapClickHandler(photo);
    setMapPanoOpenHandler(pano);
    const m = new MapMediaMarkers({ map, proj, url });
    const { s, select } = state();
    m.update(s);

    // MapLibre's own click (on the canvas container) does not see a press a marker took
    const mapClick = vi.fn();
    canvasContainer.addEventListener('click', mapClick);
    click(canvas, 104, 98);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(photo).toHaveBeenCalledWith({ kind: 'pin', layerId: 'ph', photoId: 'gps' });
    expect(mapClick).not.toHaveBeenCalled();

    click(canvas, 300, 200);
    expect(pano).toHaveBeenCalledWith('pa', 'sphere');

    // a modified click selects only
    click(canvas, 200, 100, { ctrlKey: true });
    expect(photo).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({ kind: 'photo', id: 'pinned', layer: 'ph' });

    // a double click on a plate does not zoom the map
    const mapDouble = vi.fn();
    canvasContainer.addEventListener('dblclick', mapDouble);
    click(canvas, 100, 100, { ctrlKey: true });
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    click(canvas, 100, 100, { ctrlKey: true });
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(mapDouble).not.toHaveBeenCalled();
    expect(mapClick).not.toHaveBeenCalled();

    // a press away from the markers is MapLibre's
    click(canvas, 20, 20);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(mapClick).toHaveBeenCalledTimes(1);
    expect(mapDouble).toHaveBeenCalledTimes(1);
    m.dispose();
  });

  it('enters a 360 through the workspace without a handler', () => {
    const { map, canvas, proj } = fakeMap();
    const m = new MapMediaMarkers({ map, proj, url });
    const { s, openPano } = state();
    m.update(s);
    click(canvas, 300, 200);
    expect(openPano).toHaveBeenCalledWith('pa', 'sphere');
    m.dispose();
  });

  it('skips re-projecting on a render that did not move the view', () => {
    const { map, proj } = fakeMap();
    const project = vi.spyOn(map, 'project');
    const m = new MapMediaMarkers({ map, proj, url });
    m.update(state().s);
    const after = project.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    map.triggerRepaint();
    expect(project.mock.calls.length).toBe(after);
    m.dispose();
  });

  it('draws a pinned photo at its pin, not moved by a hand correction', () => {
    const { map, proj } = fakeMap();
    const m = new MapMediaMarkers({ map, proj, url });
    const { s } = state();
    const fix = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [50, 0, 0] };
    m.update({ ...s, orientation: { photos: { ph: { pinned: fix, gps: fix } } } } as never);
    expect(m.at(200, 100)).toEqual({ kind: 'photo', layerId: 'ph', id: 'pinned' });
    // a photo with no pin keeps its correction
    expect(m.at(150, 100)).toEqual({ kind: 'photo', layerId: 'ph', id: 'gps' });
    m.dispose();
  });

  it('marks a photo whose position was edited, not a turned or pinned one', () => {
    const { map, container, proj } = fakeMap();
    const m = new MapMediaMarkers({ map, proj, url });
    const { s } = state();
    const moved = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, offsetM: [0, 5, 0] };
    const turned = { yawDeg: 10, pitchDeg: 0, rollDeg: 0 };
    const edited = () => shown(container, 'photo').map((e) => e.dataset.edited);
    m.update({ ...s, orientation: { photos: { ph: { gps: moved, pinned: moved } } } } as never);
    expect(edited()).toEqual(['true', undefined]);
    m.update({ ...s, orientation: { photos: { ph: { gps: turned } } } } as never);
    expect(edited()).toEqual([undefined, undefined]);
    m.dispose();
  });

  it('names the item under a point', () => {
    const { map, proj } = fakeMap();
    const m = new MapMediaMarkers({ map, proj, url });
    m.update(state().s);
    expect(m.at(101, 101)).toEqual({ kind: 'photo', layerId: 'ph', id: 'gps' });
    expect(m.at(299, 201)).toEqual({ kind: 'pano', layerId: 'pa', id: 'sphere' });
    expect(m.at(10, 10)).toBeNull();
    m.dispose();
  });

  it("draws photos and 360s of a lined-up date moved by that date's shift", () => {
    const { map, proj } = fakeMap();
    const m = new MapMediaMarkers({ map, proj, url });
    const { s } = state();
    const dated = {
      ...s,
      project: {
        id: 'p',
        manifest: {
          layers: layers.map((l) => ({ ...l, capture: 'd2' })),
          captures: [
            { id: 'd1', label: 'First', date: '2026-01-10' },
            {
              id: 'd2',
              label: 'Second',
              date: '2026-02-10',
              lineUp: { eastM: 50, northM: -40, with: 'd1', at: '2026-10-16T08:00:00Z' },
            },
          ],
        },
      },
    } as unknown as Workspace;
    m.update(dated);
    // x east plus 50, z south plus 40 (north minus 40)
    expect(m.at(150, 140)).toEqual({ kind: 'photo', layerId: 'ph', id: 'gps' });
    expect(m.at(350, 240)).toEqual({ kind: 'pano', layerId: 'pa', id: 'sphere' });
    expect(m.at(100, 100)).toBeNull();
    expect(m.at(300, 200)).toBeNull();
    m.dispose();
  });

  it('takes no clicks while another tool owns the pointer', () => {
    const { map, canvas, proj } = fakeMap();
    const photo = vi.fn();
    setPhotoMapClickHandler(photo);
    let busy = true;
    const m = new MapMediaMarkers({ map, proj, url, busy: () => busy });
    m.update(state().s);
    click(canvas, 100, 100);
    expect(photo).not.toHaveBeenCalled();
    busy = false;
    click(canvas, 100, 100);
    expect(photo).toHaveBeenCalledTimes(1);
    m.dispose();
  });
});
