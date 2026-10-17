// @vitest-environment jsdom
import type * as Engine from '@aio/engine';
import type * as Maps from '@aio/maps';
import type { ProjectManifest, Vec3 } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Object3D, Vector3, type Intersection } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The 3D view's answer to a raycast (a test sets it). */
let sceneHit: Intersection | null = null;
const fakeScene = {
  raycast: () => sceneHit,
  raycastRay: () => null,
};
vi.mock('@aio/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof Engine>()),
  getActiveScene: () => fakeScene,
}));

/** The map's one-shot picks, in the order they were armed. */
const mapPicks: ((local: Vec3) => void)[] = [];
const fakeMap = {
  pickPoint: (onPick: (local: Vec3) => void) => {
    mapPicks.push(onPick);
    return () => undefined;
  },
};
let mapOn = false;
vi.mock('@aio/maps', async (importOriginal) => ({
  ...(await importOriginal<typeof Maps>()),
  getActiveMap: () => (mapOn ? fakeMap : null),
  onActiveMap: () => () => undefined,
}));

const panoPicks: unknown[] = [];
vi.mock('../workspace/panoPickHook', () => ({
  setPanoPick: (fn: unknown) => panoPicks.push(fn),
}));

const { createPinStore } = await import('./pinStore');
const { usePinPicking } = await import('./placePin');
const { openPanoBeside } = await import('./openBeside');
const { shell } = await import('../shell');
const { stagePrefs } = await import('../workspace/stagePrefs');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Store = ReturnType<typeof createPinStore>;

let host: HTMLDivElement;
let pane: HTMLDivElement;
let root: Root | undefined;

function sessionStore(): Store {
  return createPinStore({
    manifest: () => null,
    save: () => Promise.resolve(null),
    openPanoBeside: vi.fn(),
  });
}

function Picking({ store }: { store: Store }) {
  usePinPicking(store);
  return null;
}

function mount(store: Store): void {
  act(() => {
    root = createRoot(host);
    root.render(createElement(Picking, { store }));
  });
}

/** A press and release on the 3D pane, `move` px apart. */
function click3d(move = 0): void {
  act(() => {
    pane.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true }),
    );
    pane.dispatchEvent(
      new MouseEvent('pointerup', { button: 0, clientX: 10 + move, clientY: 10, bubbles: true }),
    );
  });
}

const surfaceHit = (p: Vec3): Intersection => {
  const layerRoot = new Object3D();
  layerRoot.userData = { layerId: 'mesh-1' };
  const object = new Object3D();
  layerRoot.add(object);
  return { point: new Vector3(...p), object, distance: 1 };
};

const photo = { kind: 'photo' as const, layerId: 'photos', itemId: 'a' };
const pano = { kind: 'pano' as const, layerId: 'panos-1', itemId: 'p1' };

beforeEach(() => {
  host = document.createElement('div');
  pane = document.createElement('div');
  pane.className = 'pane-3d';
  pane.appendChild(document.createElement('canvas'));
  document.body.append(host, pane);
  sceneHit = null;
  mapOn = false;
  mapPicks.length = 0;
  panoPicks.length = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  pane.remove();
});

describe('usePinPicking', () => {
  it('a click in the 3D view while picking gives the hit point with its height', () => {
    const store = sessionStore();
    const pickSurface = vi.fn(() => Promise.resolve());
    store.setState({ target: photo, step: 'pick', pickSurface });
    mount(store);
    sceneHit = surfaceHit([1, 2, 3]);
    click3d();
    expect(pickSurface).toHaveBeenCalledWith([1, 2, 3], true);
  });

  it('a drag in the 3D view picks nothing', () => {
    const store = sessionStore();
    const pickSurface = vi.fn(() => Promise.resolve());
    store.setState({ target: photo, step: 'pick', pickSurface });
    mount(store);
    sceneHit = surfaceHit([1, 2, 3]);
    click3d(40);
    expect(pickSurface).not.toHaveBeenCalled();
  });

  it('a 3D click sends a landmark in the scene step and an aim in the aim step', () => {
    const store = sessionStore();
    const pickLandmark = vi.fn(() => Promise.resolve());
    const aim = vi.fn(() => Promise.resolve());
    store.setState({ target: pano, step: 'scene', pickLandmark, aim });
    mount(store);
    sceneHit = surfaceHit([4, 0, 5]);
    click3d();
    expect(pickLandmark).toHaveBeenCalledWith([4, 0, 5]);
    act(() => {
      store.setState({ target: photo, step: 'aim' });
    });
    click3d();
    expect(aim).toHaveBeenCalledWith([4, 0, 5]);
  });

  it('a map pick where no model is sits at 0 m with no known height, and re-arms', () => {
    mapOn = true;
    const store = sessionStore();
    const pickSurface = vi.fn(() => Promise.resolve());
    store.setState({ target: photo, step: 'pick', pickSurface });
    mount(store);
    expect(mapPicks).toHaveLength(1);
    act(() => {
      mapPicks[0]?.([5, 0, 7]);
    });
    expect(pickSurface).toHaveBeenCalledWith([5, 0, 7], false);
    expect(mapPicks).toHaveLength(2);
  });

  it('does not arm the map in a step that wants the 360', () => {
    mapOn = true;
    const store = sessionStore();
    store.setState({ target: pano, step: 'pano' });
    mount(store);
    expect(mapPicks).toHaveLength(0);
  });

  it('arms the 360 landmark click only while lining up, and clears it on cancel', () => {
    const store = sessionStore();
    const pickPano = vi.fn();
    store.setState({ target: pano, step: 'pick', pickPano });
    mount(store);
    expect(panoPicks.filter((p) => p !== null)).toHaveLength(0);
    act(() => {
      store.setState({ step: 'pano' });
    });
    const armed = panoPicks.at(-1);
    expect(typeof armed).toBe('function');
    const pick = armed as (p: { layerId: string; panoId: string; offsetDeg: number }) => void;
    pick({ layerId: 'panos-1', panoId: 'other', offsetDeg: 10 });
    expect(pickPano).not.toHaveBeenCalled();
    pick({ layerId: 'panos-1', panoId: 'p1', offsetDeg: 30 });
    expect(pickPano).toHaveBeenCalledWith(30);
    act(() => {
      store.getState().cancel();
    });
    expect(panoPicks.at(-1)).toBeNull();
  });

  it('never arms the 360 click for a photo', () => {
    const store = sessionStore();
    store.setState({ target: photo, step: 'aim' });
    mount(store);
    expect(panoPicks.filter((p) => p !== null)).toHaveLength(0);
  });

  it('Escape cancels the session', () => {
    const store = sessionStore();
    const cancel = vi.fn();
    store.setState({ target: photo, step: 'pick', cancel });
    mount(store);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(cancel).toHaveBeenCalled();
  });
});

describe('openPanoBeside', () => {
  const id = 'pin-open-beside-test';
  afterEach(() => {
    stagePrefs.getState().update(id, { split: undefined });
    workspace.getState().closeProject();
  });

  it('puts the Panoramas pane beside the 3D view on the 360 and selects it', () => {
    workspace.getState().openProject({
      id,
      root: 'x',
      manifest: {
        layers: [
          { kind: 'panoramas', id: 'panos-1', name: 'P', visible: true, capture: 'c2', items: [] },
        ],
      } as unknown as ProjectManifest,
    });
    stagePrefs.getState().update(id, { split: { left: '3d', right: 'map', rightCapture: 'c1' } });
    shell.setState({ screen: 'media', stageMode: '3d', stageAuto: true });
    openPanoBeside('panos-1', 'p1');
    expect(shell.getState()).toMatchObject({ screen: 'scene', stageMode: 'split' });
    expect(stagePrefs.getState().byProject[id]?.split).toEqual({
      left: '3d',
      right: 'pano',
      pano: 'panos-1/p1',
      rightCapture: 'c2',
    });
    expect(workspace.getState().selection).toEqual({ kind: 'pano', id: 'p1', layer: 'panos-1' });
  });

  it('beside the map, the map is on the left', () => {
    workspace.getState().openProject({
      id,
      root: 'x',
      manifest: { layers: [] } as unknown as ProjectManifest,
    });
    openPanoBeside('panos-1', 'p1', 'map');
    expect(stagePrefs.getState().byProject[id]?.split).toMatchObject({
      left: 'map',
      right: 'pano',
      pano: 'panos-1/p1',
    });
  });
});
