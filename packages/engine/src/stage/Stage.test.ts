// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { createWorkspace, type OpenProject } from '@aio/workspace';
import type { PerspectiveCamera } from 'three';
import {
  Box3,
  BoxGeometry,
  DataTexture,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayerAdapter, LayerHandle } from '../types';
import type { Environment } from './environment';
import { fakeWarmRenderer } from './fakeWarmRenderer';
import { clearHiddenNodes } from './nodeVisibility';
import { dampingFor, Stage } from './Stage';

type ROCallback = (entries: { contentRect: { width: number; height: number } }[]) => void;
const observers: ROCallback[] = [];
class FakeResizeObserver {
  constructor(cb: ROCallback) {
    observers.push(cb);
  }
  observe() {
    /* driven by the test */
  }
  disconnect() {
    /* nothing to release */
  }
}

function fakeRenderer() {
  const calls = { render: 0, setSize: [] as [number, number][] };
  const r = {
    shadowMap: { enabled: false, autoUpdate: true, needsUpdate: false, type: 0 },
    capabilities: { maxTextureSize: 4096, getMaxAnisotropy: () => 8 },
    info: { render: { calls: 0, triangles: 0 } },
    outputColorSpace: '',
    toneMapping: 0,
    toneMappingExposure: 1,
    localClippingEnabled: false,
    setPixelRatio: () => undefined,
    getPixelRatio: () => 1,
    setSize: (w: number, h: number) => {
      calls.setSize.push([w, h]);
    },
    render: () => {
      calls.render++;
    },
    dispose: () => undefined,
  };
  return { renderer: r as unknown as WebGLRenderer, calls };
}

const meshLayer = (id: string): Layer => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  src: { path: `models/${id}.glb` },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
});

function project(layers: Layer[]): OpenProject {
  const manifest: ProjectManifest = {
    schema: 'aio.project/1',
    id: 'p1',
    name: 'Test',
    crs: { epsg: 32639 },
    origin: [0, 0, 0],
    captures: [],
    layers,
    severityModels: [],
    classCatalogues: [],
  };
  return { id: 'p1', root: 'E:/x', manifest };
}

/** A box-shaped "model": one tagged node with one mesh, registered like the mesh adapter does. */
function boxAdapter(handles: { visible: boolean; disposed: boolean }[]): LayerAdapter {
  return {
    kind: 'mesh',
    create: async (layer, ctx) => {
      await Promise.resolve(); // loading is asynchronous, like a real GLB fetch
      const root = new Group();
      const node = new Group();
      node.name = 'TANK-1';
      node.userData = { aioNode: true, tag: 'TANK-1', name: 'Test tank' };
      const mesh = new Mesh(new BoxGeometry(10, 10, 10), new MeshStandardMaterial());
      mesh.position.y = 5;
      node.add(mesh);
      root.add(node);
      ctx.scene.scene.add(root);
      root.updateMatrixWorld(true);
      const state = { visible: true, disposed: false };
      handles.push(state);
      const off = ctx.scene.addRaycastTarget(root, layer.id);
      const h: LayerHandle = {
        setVisible(v) {
          state.visible = v;
          root.visible = v;
        },
        dispose() {
          state.disposed = true;
          off();
          ctx.scene.scene.remove(root);
        },
      };
      return h;
    },
  };
}

/** Three tagged components: two nozzles (one bigger) and the roof, like a manifest's tags. */
function taggedAdapter(): LayerAdapter {
  return {
    kind: 'mesh',
    create: (layer, ctx) => {
      const root = new Group();
      const parts: [string, number, number][] = [
        ['N1_Neck', 1, -6],
        ['N2_Neck', 2, 6],
        ['Roof_Head', 8, 0],
      ];
      for (const [name, size, x] of parts) {
        const node = new Group();
        node.name = name;
        const mesh = new Mesh(new BoxGeometry(size, size, size), new MeshStandardMaterial());
        mesh.position.set(x, 5, 0);
        node.add(mesh);
        root.add(node);
      }
      root.userData.aioTags = [
        { node: 'N1_Neck', tag: 'N1', area: 'Nozzles' },
        { node: 'N2_Neck', tag: 'N2', area: 'Nozzles' },
        { node: 'Roof_Head', tag: 'Roof head', area: 'Roof' },
      ];
      root.userData.aioTagged = new Set(['N1_Neck', 'N2_Neck', 'Roof_Head']);
      ctx.scene.scene.add(root);
      root.updateMatrixWorld(true);
      const off = ctx.scene.addRaycastTarget(root, layer.id);
      return Promise.resolve({
        setVisible(v: boolean) {
          root.visible = v;
        },
        dispose() {
          off();
        },
      });
    },
  };
}

/**
 * An engineering model like the mesh adapter shows one: two nested components (the outer one in
 * front of the inner one from any side) whose node names differ from their component ids, with
 * per-node visibility.
 */
function componentAdapter(): LayerAdapter {
  return {
    kind: 'mesh',
    create: (layer, ctx) => {
      const root = new Group();
      const steel = new MeshStandardMaterial({ name: 'steel' });
      const parts: [string, string, number][] = [
        ['Node_1', 'flue-1', 4],
        ['Node_2', 'casing-1', 10],
      ];
      for (const [name, id, size] of parts) {
        const node = new Group();
        node.name = name;
        node.userData = {
          aioNode: true,
          component: id,
          name: id === 'flue-1' ? 'Flue 1' : 'Casing',
          category: 'structure',
        };
        const mesh = new Mesh(new BoxGeometry(size, size, size), steel);
        mesh.position.y = 5;
        node.add(mesh);
        root.add(node);
      }
      ctx.scene.scene.add(root);
      root.updateMatrixWorld(true);
      const off = ctx.scene.addRaycastTarget(root, layer.id);
      return Promise.resolve({
        setVisible(v: boolean) {
          root.visible = v;
        },
        setNodeVisible(id: string, v: boolean) {
          root.traverse((o) => {
            if (o.userData.component === id) o.visible = v;
          });
        },
        components: () => [
          { id: 'flue-1', name: 'Flue 1' },
          { id: 'casing-1', name: 'Casing' },
        ],
        dispose() {
          off();
        },
      });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('dampingFor', () => {
  it('glides for the same time at 60 fps and at 5 fps', () => {
    expect(dampingFor(1000 / 60)).toBeCloseTo(0.08, 6);
    // what is left after one second: 60 small steps or 5 large ones
    const left = (dt: number, n: number) => Math.pow(1 - dampingFor(dt), n);
    expect(left(200, 5)).toBeCloseTo(left(1000 / 60, 60), 6);
    // a long stall (a hidden window) counts as a quarter second, never a jump to the end
    expect(dampingFor(5000)).toBeCloseTo(dampingFor(250), 9);
    expect(dampingFor(5000)).toBeLessThan(1);
  });
});

describe('Stage', () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    container.remove();
  });

  function make(adapter?: LayerAdapter, others: LayerAdapter[] = []) {
    const store = createWorkspace();
    const { renderer, calls } = fakeRenderer();
    const handles: { visible: boolean; disposed: boolean }[] = [];
    const stage = new Stage({
      container,
      store,
      resolveUrl: (_id, ref) => ('path' in ref ? ref.path : ref.hash),
      createRenderer: () => renderer,
      getAdapter: (kind) =>
        kind === 'mesh' ? (adapter ?? boxAdapter(handles)) : others.find((a) => a.kind === kind),
    });
    const resize = (width: number, height: number) => {
      for (const cb of observers) cb([{ contentRect: { width, height } }]);
    };
    return { stage, store, calls, handles, resize };
  }

  it('resizes and renders immediately when the container changes size', () => {
    const { stage, calls, resize } = make();
    resize(800, 600);
    expect(calls.setSize.at(-1)).toEqual([800, 600]);
    expect(calls.render).toBe(1);
    expect(stage.camera.aspect).toBeCloseTo(800 / 600);
    // sidebar collapses: the stage grows and is redrawn in the same task, never left blank
    resize(1052, 600);
    expect(calls.setSize.at(-1)).toEqual([1052, 600]);
    expect(calls.render).toBe(2);
    stage.dispose();
  });

  it('ignores zero-size layouts instead of rendering a blank canvas', () => {
    const { stage, calls, resize } = make();
    resize(0, 0);
    expect(calls.render).toBe(0);
    stage.dispose();
  });

  it('loads manifest layers, honours visibility live and disposes on project change', async () => {
    const { stage, store, handles } = make();
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    expect(handles).toHaveLength(1);
    store.getState().setLayerVisible('plant', false);
    expect(handles[0]?.visible).toBe(false);
    store.getState().setLayerVisible('plant', true);
    expect(handles[0]?.visible).toBe(true);
    store.getState().closeProject();
    expect(handles[0]?.disposed).toBe(true);
    stage.dispose();
  });

  it('keeps unchanged layers when the open project only gets a new manifest', async () => {
    const { stage, store, handles } = make();
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const before = store.getState().project?.manifest;
    if (!before) throw new Error('no project');
    store.getState().replaceManifest({ ...before, layers: [...before.layers, meshLayer('tank')] });
    await flush();
    expect(handles).toHaveLength(2);
    expect(handles[0]?.disposed).toBe(false);
    stage.dispose();
  });

  it('re-creates every layer when the same project reopens with a moved origin', async () => {
    // a re-centre: adapters (the point cloud's) read the origin only when they create a layer
    const { stage, store, handles } = make();
    const first = project([meshLayer('plant')]);
    store.getState().openProject(first);
    await flush();
    expect(handles).toHaveLength(1);
    const moved = { ...first.manifest, origin: [30_000, 0, 0] as [number, number, number] };
    store.getState().openProject({ ...first, manifest: moved });
    await flush();
    expect(handles).toHaveLength(2);
    expect(handles[0]?.disposed).toBe(true);
    expect(handles[1]?.disposed).toBe(false);
    stage.dispose();
  });

  it('frames the content on load and picks the tagged node under the cursor', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    expect(stage.controls.target.y).toBeCloseTo(5);
    const picked = stage.pick(0, 0);
    expect(picked?.node.name).toBe('TANK-1');
    expect(picked?.layerId).toBe('plant');
    expect(stage.pick(0.99, 0.99)).toBeNull();
    stage.dispose();
  });

  it('lets an overlay claim a click before the stage selects', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const canvas = container.querySelector('canvas');
    if (!canvas) throw new Error('no canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
    // jsdom has no pointer capture; the orbit controls take it on every press
    canvas.setPointerCapture = () => undefined;
    canvas.releasePointerCapture = () => undefined;
    const click = () => {
      for (const type of ['pointerdown', 'pointerup'])
        canvas.dispatchEvent(new MouseEvent(type, { clientX: 400, clientY: 300, button: 0 }));
    };
    const claimed: number[] = [];
    const release = stage.claimClicks((e) => {
      claimed.push(e.clientX);
      return true;
    });
    click();
    expect(claimed).toEqual([400]);
    expect(store.getState().selection).toBeNull();
    release();
    click();
    expect(claimed).toEqual([400]);
    expect(store.getState().selection).toMatchObject({ kind: 'asset', id: 'TANK-1' });
    stage.dispose();
  });

  describe('engineering components', () => {
    async function open() {
      clearHiddenNodes();
      const made = make(componentAdapter());
      made.resize(800, 600);
      made.store.getState().openProject(project([meshLayer('chimney')]));
      await flush();
      const canvas = container.querySelector('canvas');
      if (!canvas) throw new Error('no canvas');
      canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
      canvas.setPointerCapture = () => undefined;
      canvas.releasePointerCapture = () => undefined;
      const press = (type: string, x: number, y: number, pointerType = 'mouse') => {
        const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0 });
        Object.defineProperty(e, 'pointerType', { value: pointerType });
        canvas.dispatchEvent(e);
      };
      return { ...made, canvas, press };
    }
    const casing = {
      node: 'casing-1',
      layerId: 'chimney',
      component: { id: 'casing-1', name: 'Casing', category: 'structure' },
    };

    it('selects a component by its id with its record, and reports it', async () => {
      const { stage, store, press } = await open();
      const events: unknown[] = [];
      const off = stage.onPick((e) => events.push(e));
      expect(stage.pickAt(0, 0)).toEqual(casing);
      press('pointerdown', 400, 300);
      press('pointerup', 400, 300);
      expect(store.getState().selection).toEqual({
        kind: 'asset',
        id: 'casing-1',
        layer: 'chimney',
      });
      expect(stage.selected).toEqual(casing);
      expect(events).toContainEqual({ kind: 'select', pick: casing });
      // a selection by component id (an issue, the component panel) finds the node too
      store.getState().select({ kind: 'asset', id: 'flue-1', layer: 'chimney' });
      expect(stage.selected?.component?.name).toBe('Flue 1');
      off();
      stage.dispose();
    });

    it('does not select on an orbit drag; a background click and Escape clear the selection', async () => {
      const { stage, store, press } = await open();
      press('pointerdown', 400, 300);
      press('pointerup', 460, 300);
      expect(store.getState().selection).toBeNull();
      press('pointerdown', 400, 300, 'touch');
      press('pointerup', 405, 302, 'touch');
      expect(store.getState().selection).toMatchObject({ id: 'casing-1' });
      press('pointerdown', 790, 590);
      press('pointerup', 790, 590);
      expect(store.getState().selection).toBeNull();
      store.getState().select({ kind: 'asset', id: 'flue-1', layer: 'chimney' });
      // Escape typed in a field belongs to the field
      const input = document.createElement('input');
      container.appendChild(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(store.getState().selection).toMatchObject({ id: 'flue-1' });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(store.getState().selection).toBeNull();
      expect(stage.selected).toBeNull();
      stage.dispose();
    });

    it('reports the hovered component with its record', async () => {
      const { stage, press, canvas } = await open();
      const events: unknown[] = [];
      stage.onPick((e) => events.push(e));
      press('pointermove', 400, 300);
      await vi.waitFor(() => {
        expect(stage.hovered).toEqual(casing);
      });
      expect(events).toContainEqual({ kind: 'hover', pick: casing });
      // the hover brief tells about a component: no callout beside it
      expect(container.querySelector('[data-callout]')).toBeNull();
      canvas.dispatchEvent(new MouseEvent('pointerleave'));
      expect(stage.hovered).toBeNull();
      expect(events).toContainEqual({ kind: 'hover', pick: null });
      stage.dispose();
    });

    it('hides a component: the one behind it is picked and the highlight lets go', async () => {
      const { stage, store } = await open();
      store.getState().select({ kind: 'asset', id: 'casing-1', layer: 'chimney' });
      expect(stage.components('chimney').map((c) => c.id)).toEqual(['flue-1', 'casing-1']);
      expect(stage.setNodeVisible('chimney', 'casing-1', false)).toBe(true);
      expect(stage.pickAt(0, 0)?.node).toBe('flue-1');
      // still selected (the panel can show it again), but nothing is drawn for it
      const overlays = () => stage.scene.getObjectByName('engine:highlight')?.children.length;
      expect(stage.selected?.node).toBe('casing-1');
      expect(overlays()).toBe(0);
      // nor a callout
      expect(container.querySelector('[data-callout="Node_2"]')).toBeNull();
      expect(stage.hiddenNodes('chimney')).toEqual(['casing-1']);
      expect(stage.setNodeVisible('chimney', 'casing-1', true)).toBe(true);
      expect(overlays()).toBeGreaterThan(0);
      expect(container.querySelector('[data-callout="Node_2"]')).not.toBeNull();
      expect(stage.hiddenNodes('chimney')).toEqual([]);
      expect(stage.setNodeVisible('no-layer', 'casing-1', false)).toBe(false);
      stage.dispose();
    });

    it('keeps a component hidden when its layer loads again, in every view of it', async () => {
      const { stage, store } = await open();
      const other = make(componentAdapter());
      other.resize(800, 600);
      other.store.getState().openProject(project([meshLayer('chimney')]));
      await flush();
      const changes: string[] = [];
      other.stage.onHiddenNodes((id) => changes.push(id));
      expect(stage.setNodeVisible('chimney', 'casing-1', false)).toBe(true);
      // the second view (comparing dates) follows
      expect(other.stage.pickAt(0, 0)?.node).toBe('flue-1');
      expect(changes).toEqual(['chimney']);
      // the layer is made again (its definition changed): the new copy starts hidden too
      store.getState().openProject(project([{ ...meshLayer('chimney'), name: 'renamed' }]));
      await flush();
      expect(stage.pickAt(0, 0)?.node).toBe('flue-1');
      expect(stage.hiddenNodes('chimney')).toEqual(['casing-1']);
      stage.setNodeVisible('chimney', 'casing-1', true);
      expect(stage.pickAt(0, 0)?.node).toBe('casing-1');
      expect(other.stage.pickAt(0, 0)?.node).toBe('casing-1');
      other.stage.dispose();
      stage.dispose();
    });
  });

  it('raycasts against content first and the ground plane otherwise', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    expect(stage.raycast(0, 0)?.object.type).toBe('Mesh');
    const ground = stage.raycast(0.99, -0.99);
    expect(ground?.point.y).toBeCloseTo(0, 6);
    stage.dispose();
  });

  it('casts world rays against content, ignoring section planes, then the ground', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    stage.setSection({ enabled: true, bearingDeg: 0 });
    const hit = stage.raycastRay(new Vector3(0, 5, 50), new Vector3(0, 0, -1));
    expect(hit?.object.type).toBe('Mesh');
    expect(hit?.point.z).toBeCloseTo(5);
    const ground = stage.raycastRay(new Vector3(30, 10, 30), new Vector3(0, -1, 0));
    expect(ground?.point.y).toBeCloseTo(0, 6);
    expect(stage.raycastRay(new Vector3(30, 10, 30), new Vector3(0, 1, 0))).toBeNull();
    stage.dispose();
  });

  it('keeps the nearest of mesh hits and raycast providers', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const mesh = stage.raycast(0, 0);
    expect(mesh).not.toBeNull();
    const near = new Points();
    const off = stage.addRaycastProvider(() => ({
      distance: (mesh?.distance ?? 0) - 1,
      point: new Vector3(),
      object: near,
    }));
    expect(stage.raycast(0, 0)?.object).toBe(near);
    off();
    expect(stage.raycast(0, 0)?.object.type).toBe('Mesh');
    stage.addRaycastProvider(() => ({
      distance: (mesh?.distance ?? 0) + 1,
      point: new Vector3(),
      object: near,
    }));
    expect(stage.raycast(0, 0)?.object.type).toBe('Mesh');
    stage.dispose();
  });

  it('consumes camera requests and flies to a selected asset', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    store.getState().flyTo({ kind: 'selection', selection: { kind: 'asset', id: 'TANK-1' } });
    expect(store.getState().camera).toBeNull();
    store.getState().flyTo({ kind: 'point', p: [100, 0, 100], distance: 50 });
    expect(store.getState().camera).toBeNull();
    stage.dispose();
  });

  it('flies to a point from a requested direction and reports the content bounds', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true })); // reduced motion: no animation
    const { stage, store, resize } = make();
    resize(800, 600);
    expect(stage.contentBounds()).toBeNull();
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const box = stage.contentBounds();
    expect(box?.min.toArray()).toEqual([-5, 0, -5]);
    expect(box?.max.toArray()).toEqual([5, 10, 5]);
    // straight down from 50 m above, then from the east at 20 m
    store.getState().flyTo({ kind: 'point', p: [10, 0, -20], distance: 50, dir: [0, 2, 0] });
    let v = stage.saveView();
    expect(v.target).toEqual([10, 0, -20]);
    expect(v.position[1]).toBeCloseTo(50);
    expect(v.position[0]).toBeCloseTo(10);
    store.getState().flyTo({ kind: 'point', p: [0, 0, 0], distance: 20, dir: [1, 0, 0] });
    v = stage.saveView();
    expect(v.position[0]).toBeCloseTo(20);
    expect(v.position[2]).toBeCloseTo(0);
    // looking up from below (a photo inside a tank): the orbit limit lets the pose stand
    store.getState().flyTo({ kind: 'point', p: [0, 9, 0], distance: 5, dir: [0, -1, 0.3] });
    stage.controls.update();
    v = stage.saveView();
    expect(v.position[1]).toBeLessThan(5);
    expect(Math.hypot(v.position[0], v.position[1] - 9, v.position[2])).toBeCloseTo(5);
    stage.dispose();
  });

  it('frames flights and photos while no model is shown, then the model', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([]));
    await flush();
    expect(stage.contentBounds()).toBeNull();
    // a video-first project: the flight path frames the view (never pickable)
    const flight = new Box3(new Vector3(200, 40, -300), new Vector3(600, 60, 100));
    const off = stage.addContentBounds(() => flight);
    expect(stage.contentBounds()?.max.toArray()).toEqual([600, 60, 100]);
    const v = stage.saveView();
    expect(v.target[0]).toBeCloseTo(400, 0);
    expect(v.target[2]).toBeCloseTo(-100, 0);
    // Home flies there too
    stage.setViewPreset('home');
    expect(stage.saveView().target[0]).toBeCloseTo(400, 0);
    // a model arriving later frames the view again, on its own
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    expect(stage.contentBounds()?.max.toArray()).toEqual([5, 10, 5]);
    off();
    stage.dispose();
  });

  it('lets always-bounds widen only the camera reach beside a model', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const env = (stage as unknown as { env: Environment }).env;
    const radius = vi.spyOn(env, 'setContentRadius');
    const shadow = vi.spyOn(env, 'setShadowBounds');
    const model = stage.contentBounds()?.clone();
    const range = stage.controls.maxDistance;
    const wide = new Box3(new Vector3(0, 0, 0), new Vector3(400, 40, 0));
    const fits = () => stage.saveView();
    const home = fits();
    // a photo-style registration still only counts without a model
    const offPlain = stage.addContentBounds(() => wide);
    expect(stage.contentBounds()?.max.toArray()).toEqual(model?.max.toArray());
    expect(stage.controls.maxDistance).toBe(range);
    offPlain();
    radius.mockClear();
    shadow.mockClear();
    // an always registration only widens how far the camera can zoom out and see
    const off = stage.addContentBounds(() => wide, { always: true });
    expect(stage.controls.maxDistance).toBeGreaterThan(400);
    // four times the farthest marker corner from the content centre (about 401 m)
    expect(stage.controls.maxDistance).toBeGreaterThanOrEqual(400 * 4);
    const sizeOf = (b: Box3 | undefined) => b?.getSize(new Vector3()).length() ?? 0;
    expect(radius.mock.calls[0]?.[0]).toBeCloseTo(sizeOf(model) / 2);
    const sb = shadow.mock.calls[0]?.[0];
    expect(sb?.max.x).toBeCloseTo(model?.max.x ?? NaN);
    expect(stage.contentBounds()?.max.toArray()).toEqual(model?.max.toArray());
    const camera = (stage as unknown as { camera: PerspectiveCamera }).camera;
    env.update(camera, stage.controls.target, 0);
    expect(camera.far).toBeGreaterThanOrEqual(400 * 20);
    expect(fits().position).toEqual(home.position);
    off();
    expect(stage.controls.maxDistance).toBe(range);
    stage.dispose();
  });

  it('solid bounds frame like a model, and a hidden cloud leaves the framing to the rest', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const range = stage.controls.maxDistance;
    let shown = true;
    const cloud = new Box3(new Vector3(300, 0, -20), new Vector3(400, 30, 20));
    const off = stage.addContentBounds(() => (shown ? cloud : null), { solid: true });
    expect(stage.contentBounds()?.max.x).toBe(400);
    expect(stage.controls.maxDistance).toBeGreaterThan(range);
    stage.setViewPreset('home');
    expect(stage.saveView().target[0]).toBeGreaterThan(100);
    shown = false;
    stage.contentUpdated();
    // hidden: Home and the bounds follow the model again (the cap may stay held where the
    // camera stands, as `applyDistanceCap` does for a reach that shrinks)
    expect(stage.contentBounds()?.max.toArray()).toEqual([5, 10, 5]);
    off();
    stage.dispose();
  });

  describe('a removed layer the camera looked at', () => {
    // photo places frame like the photos adapter: bounds while there is no model
    const placesAdapter: LayerAdapter = {
      kind: 'photos',
      create: async (layer, ctx) => {
        await Promise.resolve();
        const items = layer.kind === 'photos' ? layer.items : [];
        const box = new Box3().setFromPoints(
          items.map((p) => new Vector3(...(p.pos ?? [0, 0, 0]))),
        );
        const off = ctx.scene.addContentBounds(() => box);
        return { setVisible: () => undefined, dispose: off };
      },
    };
    const places = (id: string, x: number): Layer => ({
      kind: 'photos',
      id,
      name: id,
      visible: true,
      items: [
        { id: `${id}-a`, src: { path: `photos/${id}-a.jpg` }, pos: [x - 100, 2, -100] },
        { id: `${id}-b`, src: { path: `photos/${id}-b.jpg` }, pos: [x + 100, 2, 100] },
      ],
    });
    const plan = (v: { target: number[] }) => Math.hypot(v.target[0] ?? 0, v.target[2] ?? 0);

    async function opened() {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      const made = make(undefined, [placesAdapter]);
      made.resize(800, 600);
      made.store.getState().openProject(project([places('drone', 0), places('phone', 91_000)]));
      await flush();
      return made;
    }
    const without = (store: ReturnType<typeof make>['store'], id: string) => {
      const m = store.getState().project?.manifest;
      if (!m) throw new Error('no project');
      store.getState().replaceManifest({ ...m, layers: m.layers.filter((l) => l.id !== id) });
    };

    it('frames the project again when the layer the camera looked at goes', async () => {
      const { stage, store } = await opened();
      store.getState().flyTo({ kind: 'point', p: [91_000, 0, 0], distance: 300 });
      expect(plan(stage.saveView())).toBeGreaterThan(90_000);
      without(store, 'phone');
      await flush();
      expect(plan(stage.saveView())).toBeLessThan(200);
      stage.dispose();
    });

    it('frames the project again when several layers go in one edit', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      const { stage, store, resize } = make(undefined, [placesAdapter]);
      resize(800, 600);
      store
        .getState()
        .openProject(
          project([places('drone', 0), places('phone', 91_000), places('tablet', 95_000)]),
        );
      await flush();
      store.getState().flyTo({ kind: 'point', p: [95_000, 0, 0], distance: 300 });
      const m = store.getState().project?.manifest;
      if (!m) throw new Error('no project');
      store.getState().replaceManifest({ ...m, layers: m.layers.filter((l) => l.id === 'drone') });
      await flush();
      expect(plan(stage.saveView())).toBeLessThan(200);
      stage.dispose();
    });

    it('leaves the view alone when the camera still looks at the project', async () => {
      const { stage, store } = await opened();
      store.getState().flyTo({ kind: 'point', p: [91_050, 0, 20], distance: 300 });
      const before = stage.saveView();
      without(store, 'drone');
      await flush();
      expect(stage.saveView()).toEqual(before);
      stage.dispose();
    });
  });

  describe('centre on project', () => {
    const plan = (v: { target: number[] }) => Math.hypot(v.target[0] ?? 0, v.target[2] ?? 0);

    it('frames the photos near the origin and leaves out photos a bad GPS put far away', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      const { stage, store, resize } = make();
      resize(800, 600);
      store.getState().openProject(project([]));
      await flush();
      // a drone survey around the origin, and a layer of phone photos 91 km away
      const drone = new Box3(new Vector3(-150, 0, -100), new Vector3(150, 60, 100));
      const phones = new Box3(new Vector3(91_000, 0, 0), new Vector3(91_200, 5, 300));
      const offA = stage.addContentBounds(() => drone);
      const offB = stage.addContentBounds(() => phones);
      // one layer mixing near and far photos says which part is near
      const mixed = new Box3(new Vector3(-50, 0, -50), new Vector3(90_000, 5, 50));
      const mixedNear = new Box3(new Vector3(-50, 0, -50), new Vector3(50, 5, 50));
      const offC = stage.addContentBounds(() => mixed, { near: () => mixedNear });
      // Home still frames everything
      stage.setViewPreset('home');
      expect(plan(stage.saveView())).toBeGreaterThan(10_000);
      store.getState().flyTo({ kind: 'site' });
      const v = stage.saveView();
      expect(plan(v)).toBeLessThan(200);
      const range = Math.hypot(...v.position.map((p, i) => p - (v.target[i] ?? 0)));
      expect(range).toBeLessThan(2_000);
      expect(stage.controls.minDistance).toBeLessThan(5);
      expect(store.getState().camera).toBeNull();
      offA();
      offB();
      offC();
      stage.dispose();
    });

    it('frames the models and clouds when there are any', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      const { stage, store, resize } = make();
      resize(800, 600);
      store.getState().openProject(project([]));
      await flush();
      const cloud = new Box3(new Vector3(300, 0, -20), new Vector3(400, 30, 20));
      const photos = new Box3(new Vector3(-500, 0, -500), new Vector3(-400, 5, -400));
      const offA = stage.addContentBounds(() => cloud, { solid: true });
      const offB = stage.addContentBounds(() => photos);
      store.getState().flyTo({ kind: 'site' });
      expect(stage.saveView().target[0]).toBeCloseTo(350, 0);
      offA();
      offB();
      stage.dispose();
    });

    it('looks at the origin of an empty project', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }));
      const { stage, store, resize } = make();
      resize(800, 600);
      store.getState().openProject(project([]));
      await flush();
      // somewhere else first
      store.getState().flyTo({ kind: 'point', p: [5_000, 0, 5_000], distance: 50 });
      store.getState().flyTo({ kind: 'site' });
      const v = stage.saveView();
      expect(plan(v)).toBeLessThan(1);
      const range = Math.hypot(...v.position.map((p, i) => p - (v.target[i] ?? 0)));
      expect(range).toBeGreaterThan(100);
      expect(range).toBeLessThan(2_000);
      stage.dispose();
    });
  });

  it('a reach lets the camera back off far enough to see it, without reframing', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const cap = stage.controls.maxDistance;
    const target = stage.saveView().target;
    // a walk far longer than the model: the cap grows to cover it
    stage.setReach('walk', new Box3(new Vector3(-500, 0, -10), new Vector3(500, 2, 10)));
    expect(stage.controls.maxDistance).toBeGreaterThanOrEqual(1000);
    expect(stage.contentBounds()?.max.toArray()).toEqual([5, 10, 5]);
    expect(stage.saveView().target).toEqual(target);
    // a reach inside the content changes nothing; clearing it brings the old cap back
    stage.setReach('walk', new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1)));
    expect(stage.controls.maxDistance).toBeCloseTo(cap);
    stage.setReach('walk', null);
    expect(stage.controls.maxDistance).toBeCloseTo(cap);
    stage.dispose();
  });

  it('a reach that clears holds a backed-off camera, then tightens as it comes in', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const cap = stage.controls.maxDistance;
    const fog = stage.scene.fog as { far: number };
    const fogBefore = fog.far;
    stage.setReach('walk', new Box3(new Vector3(-500, 0, -10), new Vector3(500, 2, 10)));
    // the walk's far end stays clear of the fog from the farthest the camera may stand
    expect(fog.far).toBeGreaterThan(stage.controls.maxDistance);
    // the camera backs off to see the walk
    const t = stage.controls.target;
    const away = (d: number) => {
      stage.camera.position.copy(t).add(new Vector3(0, 0, d));
      stage.controls.dispatchEvent({ type: 'change' });
    };
    away(1500);
    stage.setReach('walk', null);
    // no snap inward: the cap stays at the camera, the fog too
    expect(stage.controls.maxDistance).toBeCloseTo(1500);
    expect(fog.far).toBeGreaterThan(1500);
    away(800);
    expect(stage.controls.maxDistance).toBeCloseTo(800);
    away(cap / 2);
    expect(stage.controls.maxDistance).toBeCloseTo(cap);
    expect(fog.far).toBeCloseTo(fogBefore);
    stage.dispose();
  });

  it('keeps a selection camera request until its layer has loaded', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    store.getState().flyTo({ kind: 'selection', selection: { kind: 'asset', id: 'TANK-1' } });
    expect(store.getState().camera).not.toBeNull();
    await flush();
    expect(store.getState().camera).toBeNull();
    stage.dispose();
  });

  it('shares one clipping array with the section tool', () => {
    const { stage } = make();
    const planes = stage.clippingPlanes;
    stage.setSection({ enabled: true, bearingDeg: 45 });
    expect(stage.clippingPlanes).toBe(planes);
    expect(planes).toHaveLength(1);
    stage.setSection({ enabled: false });
    expect(planes).toHaveLength(0);
    stage.dispose();
  });

  describe('shader programs made ahead of the frame', () => {
    /** The poll timer of the warm-up (16 ms) has fired. */
    const polled = () => new Promise((r) => setTimeout(r, 60));

    /**
     * A stage on a renderer that can make programs ahead, with a mesh that takes the section
     * planes (as every layer's materials do) and receives projected video (its side follows the
     * section). `drawn` is what each frame was drawn with.
     */
    function makeWarm(parallel: boolean) {
      const warm = fakeWarmRenderer({ parallel });
      const { renderer, calls } = fakeRenderer();
      const drawn: { planes: number; side: number }[] = [];
      let frame: FrameRequestCallback = () => undefined;
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        frame = cb;
        return 1;
      });
      const wall = new Mesh(new BoxGeometry(4, 4, 4), new MeshStandardMaterial({ name: 'wall' }));
      const stage: Stage = new Stage({
        container,
        store: createWorkspace(),
        resolveUrl: (_id, ref) => ('path' in ref ? ref.path : ref.hash),
        createRenderer: () =>
          Object.assign(renderer, warm.renderer, {
            properties: { ...warm.renderer.properties, has: () => false },
            render: () => {
              calls.render++;
              drawn.push({ planes: stage.clippingPlanes.length, side: wall.material.side });
            },
          }),
      });
      wall.material.clippingPlanes = stage.clippingPlanes;
      stage.scene.add(wall);
      stage.addProjectionReceiver(wall);
      for (const cb of observers) cb([{ contentRect: { width: 800, height: 600 } }]);
      let now = 0;
      /** The next animation frame. */
      const tick = () => {
        now += 16;
        frame(now);
      };
      return { stage, warm, calls, drawn, wall, tick };
    }

    it('draws the section it had until the programs of the new one are in', async () => {
      const { stage, warm, drawn, wall, tick } = makeWarm(true);
      stage.setSection({ enabled: true, bearingDeg: 45 });
      // what was asked for holds at once: picking, the tools and the toolbar read it
      expect(stage.clippingPlanes).toHaveLength(1);
      expect(stage.section.enabled).toBe(true);
      expect(wall.material.side).toBe(DoubleSide);
      expect(stage.compiling).toBe(1);
      // the new programs were made for the section asked for
      expect(warm.compiled.at(-1)).toBe(`wall/1/${String(DoubleSide)}`);
      const plane = stage.clippingPlanes[0];
      tick();
      tick();
      // the view keeps drawing, uncut, while the compiler works
      expect(drawn.slice(-2)).toEqual([
        { planes: 0, side: FrontSide },
        { planes: 0, side: FrontSide },
      ]);
      // and between frames the section is the one asked for, the same plane object
      expect(stage.clippingPlanes[0]).toBe(plane);
      expect(wall.material.side).toBe(DoubleSide);
      warm.finish();
      await polled();
      expect(stage.compiling).toBe(0);
      tick();
      expect(drawn.at(-1)).toEqual({ planes: 1, side: DoubleSide });
      stage.dispose();
    });

    it('keeps the cut on screen while the programs without it are made', async () => {
      const { stage, warm, drawn, tick } = makeWarm(true);
      stage.setSection({ enabled: true, bearingDeg: 0, offset: 2 });
      warm.finish();
      await polled();
      tick();
      expect(drawn.at(-1)?.planes).toBe(1);
      // a layer loaded while the cut was on has no program without it yet
      const late = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ name: 'late' }));
      late.material.clippingPlanes = stage.clippingPlanes;
      stage.scene.add(late);
      warm.renderer.compile(late, stage.camera, stage.scene);
      warm.finish();
      stage.setSection({ enabled: false });
      expect(stage.clippingPlanes).toHaveLength(0);
      expect(stage.compiling).toBe(1);
      tick();
      expect(drawn.at(-1)).toEqual({ planes: 1, side: DoubleSide });
      warm.finish();
      await polled();
      tick();
      expect(drawn.at(-1)).toEqual({ planes: 0, side: FrontSide });
      stage.dispose();
    });

    it('draws at once when the programs of a section exist already', async () => {
      const { stage, warm, drawn, tick } = makeWarm(true);
      // the frames so far made the programs of the uncut view
      warm.renderer.compile(stage.scene, stage.camera, stage.scene);
      stage.setSection({ enabled: true });
      warm.finish();
      await polled();
      stage.setSection({ enabled: false });
      expect(stage.compiling).toBe(0);
      tick();
      expect(drawn.at(-1)?.planes).toBe(0);
      stage.setSection({ enabled: true });
      expect(stage.compiling).toBe(0);
      tick();
      expect(drawn.at(-1)?.planes).toBe(1);
      stage.dispose();
    });

    it('follows the last switch when the section is switched again while it waits', async () => {
      const { stage, warm, drawn, tick } = makeWarm(true);
      stage.setSection({ enabled: true });
      // off again before the cut was ever drawn: nothing to wait for, the view stays uncut
      stage.setSection({ enabled: false });
      tick();
      expect(drawn.at(-1)).toEqual({ planes: 0, side: FrontSide });
      warm.finish();
      await polled();
      tick();
      expect(drawn.at(-1)).toEqual({ planes: 0, side: FrontSide });
      expect(stage.clippingPlanes).toHaveLength(0);
      stage.dispose();
    });

    it('moves the cut freely while it waits: only switching it compiles', () => {
      const { stage, warm } = makeWarm(true);
      stage.setSection({ enabled: true });
      const made = warm.compiled.length;
      stage.setSection({ bearingDeg: 120, offset: 3 });
      stage.setSection({ enabled: true, flip: true });
      expect(warm.compiled).toHaveLength(made);
      stage.dispose();
    });

    it('sends no frame while a software renderer catches up, then draws the cut', async () => {
      const { stage, warm, calls, drawn, tick } = makeWarm(false);
      tick();
      const before = calls.render;
      stage.setSection({ enabled: true });
      expect(warm.fences).toHaveLength(1);
      tick();
      tick();
      // a frame now would queue in front of the questions the new programs wait for
      expect(calls.render).toBe(before);
      // a resize still draws, with the section the view had: the canvas is never left blank
      for (const cb of observers) cb([{ contentRect: { width: 900, height: 600 } }]);
      expect(calls.render).toBe(before + 1);
      expect(drawn.at(-1)?.planes).toBe(0);
      warm.reach();
      await polled();
      tick();
      expect(calls.render).toBe(before + 2);
      expect(drawn.at(-1)).toEqual({ planes: 1, side: DoubleSide });
      stage.dispose();
    });

    it('resolves compileAhead when the programs are in, drawing meanwhile', async () => {
      const { stage, warm, calls, tick } = makeWarm(true);
      const tile = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ name: 'tile' }));
      let ready = false;
      void stage.compileAhead(tile).then(() => {
        ready = true;
      });
      const before = calls.render;
      stage.requestRender();
      tick();
      expect(calls.render).toBe(before + 1);
      await polled();
      expect(ready).toBe(false);
      warm.finish();
      await polled();
      expect(ready).toBe(true);
      stage.dispose();
    });

    it('lets go of what is compiling when the context is lost or the stage disposed', async () => {
      const { stage, warm, drawn, tick } = makeWarm(true);
      const done: string[] = [];
      const tile = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ name: 'tile' }));
      void stage.compileAhead(tile).then(() => done.push('tile'));
      stage.setSection({ enabled: true });
      warm.lost = true;
      stage.canvas.dispatchEvent(new Event('webglcontextlost'));
      await flush();
      expect(done).toEqual(['tile']);
      expect(stage.compiling).toBe(0);
      // restored: the section asked for is drawn (three makes every program again)
      warm.lost = false;
      stage.canvas.dispatchEvent(new Event('webglcontextrestored'));
      tick();
      expect(drawn.at(-1)?.planes).toBe(1);

      const other = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ name: 'other' }));
      void stage.compileAhead(other).then(() => done.push('other'));
      stage.setSection({ enabled: false });
      stage.dispose();
      await flush();
      expect(done).toEqual(['tile', 'other']);
      // nothing compiles for a disposed stage
      await expect(stage.compileAhead(other)).resolves.toBeUndefined();
    });

    it('draws at once on a renderer that cannot make programs ahead', async () => {
      const { stage, calls, resize } = make();
      resize(800, 600);
      const before = calls.render;
      stage.setSection({ enabled: true });
      expect(stage.compiling).toBe(0);
      stage.renderNow();
      expect(calls.render).toBe(before + 1);
      await expect(stage.compileAhead(new Group())).resolves.toBeUndefined();
      stage.dispose();
    });
  });

  it('labels component groups by default, every component on demand, none when off', async () => {
    const { stage, store, resize } = make(taggedAdapter());
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    const ids = () =>
      [...container.querySelectorAll<HTMLElement>('[data-callout]')]
        .map((e) => e.dataset.callout)
        .sort();
    expect(stage.labelMode).toBe('key');
    // one callout per group; a group of one shows its component
    expect(ids()).toEqual(['Roof_Head', 'group:Nozzles']);
    const group = container.querySelector('[data-callout="group:Nozzles"]');
    expect(group?.textContent).toContain('2 components');
    stage.setLabelMode('all');
    expect(ids()).toEqual(['N1_Neck', 'N2_Neck', 'Roof_Head']);
    stage.setLabelMode('off');
    expect(ids()).toEqual([]);
    // the selection is always labelled
    store.getState().select({ kind: 'asset', id: 'N1_Neck', layer: 'plant' });
    expect(ids()).toEqual(['N1_Neck']);
    stage.dispose();
  });

  it('restores a saved view and stops framing content once restored', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    // restored before the layers finish loading: loading must not reframe
    stage.restoreView({ position: [40, 30, 20], target: [1, 2, 3] });
    await flush();
    const v = stage.saveView();
    expect(v.target).toEqual([1, 2, 3]);
    expect(v.position[0]).toBeCloseTo(40);
    stage.dispose();
  });

  it('toggles the perf HUD with Ctrl+Shift+F, also without dev tools', () => {
    const { stage, resize } = make();
    resize(800, 600);
    const hud = () => container.querySelector<HTMLElement>('[data-perf-hud]');
    expect(hud()?.style.display).toBe('none');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }));
    expect(hud()?.style.display).toBe('');
    stage.renderNow(16, 1000);
    stage.renderNow(16, 1016);
    const s = stage.perfStats();
    expect(s.frames).toBeGreaterThan(0);
    expect(s.p95).toBeGreaterThan(0);
    expect(hud()?.textContent).toContain('fps');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }));
    expect(hud()?.style.display).toBe('none');
    stage.dispose();
  });

  // perf e2e, flaky on the Windows runner: the last frame's points outlived a lost context, so a
  // wait for the restored frame passed at once and the restored frame then held the page.
  it('reports nothing drawn while its context is lost, until a frame draws again', () => {
    const { stage, resize } = make();
    resize(800, 600);
    const render = (stage.renderer.info as unknown as { render: { points: number } }).render;
    Object.assign(stage.renderer.info, {
      reset: () => {
        render.points = 0;
      },
    });
    render.points = 16000;
    expect(stage.perfStats().points).toBe(16000);
    stage.canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(stage.contextLost).toBe(true);
    expect(stage.perfStats().points).toBe(0);
    stage.dispose();
  });

  it('applies quality presets: pixel ratio cap and shadow map size', () => {
    const { stage, resize } = make();
    resize(800, 600);
    const spy = vi.spyOn(stage.renderer, 'setPixelRatio');
    stage.setQuality({ maxPixelRatio: 1, shadowMapSize: 1024 });
    expect(spy).toHaveBeenCalledWith(Math.min(window.devicePixelRatio || 1, 1));
    const sun = stage.scene.getObjectByName('env:sun') as unknown as {
      shadow: { mapSize: { x: number } };
    };
    expect(sun.shadow.mapSize.x).toBe(1024);
    expect(stage.quality).toMatchObject({ maxPixelRatio: 1, shadowMapSize: 1024 });
    stage.dispose();
  });

  describe('environment', () => {
    const ortho: Layer = {
      kind: 'raster',
      id: 'ortho',
      name: 'Ortho',
      visible: true,
      src: { path: 'rasters/ortho.jpg' },
      role: 'ortho',
      format: 'image',
      corners: { tl: [-100, 0, -100], tr: [100, 0, -100], bl: [-100, 0, 100] },
    };
    const site = (layers: Layer[]): OpenProject => {
      const p = project(layers);
      return {
        ...p,
        manifest: {
          ...p.manifest,
          origin: [245714, 3179542, 100],
          captures: [{ id: 'c', label: 'Survey', date: '2023-02-21' }],
        },
      };
    };

    it('lights a placed site with ground imagery by the sky, anything else in the studio', () => {
      const { stage, store } = make();
      store.getState().openProject(site([meshLayer('plant'), ortho]));
      expect(stage.environment.mode).toBe('sky');
      expect(stage.environment.location?.lat).toBeCloseTo(28.73, 1);
      expect(stage.environment.location?.lon).toBeCloseTo(48.38, 1);
      // capture date at 10:00 site time (UTC+3)
      expect(new Date(stage.environment.timeMs).toISOString()).toBe('2023-02-21T07:00:00.000Z');
      store.getState().openProject({ ...site([meshLayer('tank')]), id: 'p2' });
      expect(stage.environment.mode).toBe('studio');
      store.getState().openProject({ ...project([meshLayer('x'), ortho]), id: 'p3' });
      expect(stage.environment.mode).toBe('studio'); // no geographic origin
      stage.dispose();
    });

    it('moves the sun with the time of day and keeps a moon light at night', () => {
      const { stage, store } = make();
      store.getState().openProject(site([meshLayer('plant'), ortho]));
      const changed = vi.fn();
      stage.onStateChange(changed);
      stage.setEnvironment({ timeMs: Date.UTC(2023, 1, 21, 5, 0) }); // 08:00 local
      const morning = stage.environment.sun;
      stage.setEnvironment({ timeMs: Date.UTC(2023, 1, 21, 14, 0) }); // 17:00 local
      const evening = stage.environment.sun;
      expect(changed).toHaveBeenCalled();
      expect(morning.direction[0]).toBeGreaterThan(0.3); // east
      expect(evening.direction[0]).toBeLessThan(-0.3); // west
      expect(evening.elevationDeg).toBeLessThan(morning.elevationDeg + 20);
      stage.setEnvironment({ timeMs: Date.UTC(2023, 1, 21, 20, 0) }); // 23:00 local
      expect(stage.environment.sun.elevationDeg).toBeLessThan(-20);
      expect(stage.environment.night).toBe(1);
      expect(stage.environment.lightDirection[1]).toBeGreaterThan(0.5);
      stage.dispose();
    });

    it('shows water at the sea level found in the data, or a level set by hand', () => {
      const { stage, store } = make();
      store.getState().openProject(site([meshLayer('plant'), ortho]));
      expect(stage.environment.waterShown).toBe(false);
      stage.setWaterLevel(-6.44);
      expect(stage.environment).toMatchObject({ dataWaterLevel: -6.44, waterShown: true });
      expect(stage.scene.getObjectByName('env:water')?.position.y).toBeCloseTo(-6.44);
      stage.setEnvironment({ water: false });
      expect(stage.environment.waterShown).toBe(false);
      expect(stage.scene.getObjectByName('env:water')).toBeUndefined();
      stage.setEnvironment({ water: true, waterLevel: -2 });
      expect(stage.scene.getObjectByName('env:water')?.position.y).toBeCloseTo(-2);
      stage.setEnvironment({ waterLevel: null });
      expect(stage.scene.getObjectByName('env:water')?.position.y).toBeCloseTo(-6.44);
      stage.dispose();
    });

    it('switches backdrops: sky dome and studio dome', () => {
      const { stage, store } = make();
      store.getState().openProject(site([meshLayer('plant'), ortho]));
      const sky = () => stage.scene.getObjectByName('env:physicalSky');
      const dome = () => stage.scene.getObjectByName('env:sky');
      expect(sky()?.visible).toBe(true);
      expect(dome()?.visible).toBe(false);
      stage.setEnvironment({ mode: 'studio' });
      expect(sky()?.visible).toBe(false);
      expect(dome()?.visible).toBe(true);
      stage.dispose();
    });
  });

  it('removes its canvas and stops listening on dispose', () => {
    const { stage, store } = make();
    expect(container.querySelector('canvas')).not.toBeNull();
    stage.dispose();
    expect(container.querySelector('canvas')).toBeNull();
    store.getState().openProject(project([meshLayer('plant')]));
    expect(stage.projectId).toBe('');
  });
  // T8 soak: a renderer leaked per project opened, and with it the detached workspace DOM.
  it('takes the orbit controls key listener off the document after the view was detached', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const { stage } = make();
    // the spies sit on EventTarget.prototype: keep the calls made on the document itself
    const onDocument = (spy: typeof add) =>
      spy.mock.calls.filter((_, i) => spy.mock.contexts[i] === document);
    const added = onDocument(add).find(([type, , opts]) => type === 'keydown' && opts);
    expect(added).toBeDefined();
    // (connecting took it off once, in case it was there)
    remove.mockClear();
    // React detaches the view before its effects clean up
    container.remove();
    stage.dispose();
    expect(onDocument(remove)).toContainEqual(['keydown', added?.[1], { capture: true }]);
    expect(Object.hasOwn(stage.canvas, 'getRootNode')).toBe(false);
    add.mockRestore();
    remove.mockRestore();
  });

  it("disposes three's module-level textures it drew with, so they let go of its renderer", () => {
    const lut = new DataTexture(new Uint8Array(4), 1, 1);
    const listener = vi.fn();
    lut.addEventListener('dispose', listener); // as WebGLTextures does for each renderer
    const { renderer } = fakeRenderer();
    const uniforms = { dfgLUT: { value: lut } };
    Object.assign(renderer, {
      properties: { has: () => true, get: () => ({ uniforms }) },
    });
    const stage = new Stage({
      container,
      store: createWorkspace(),
      resolveUrl: (_id, ref) => ('path' in ref ? ref.path : ref.hash),
      createRenderer: () => renderer,
    });
    expect(listener).not.toHaveBeenCalled();
    stage.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
