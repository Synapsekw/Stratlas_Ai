// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { createWorkspace, type OpenProject } from '@aio/workspace';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayerAdapter, LayerHandle } from '../types';
import { Stage } from './Stage';

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

const flush = () => new Promise((r) => setTimeout(r, 0));

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

  function make(adapter?: LayerAdapter) {
    const store = createWorkspace();
    const { renderer, calls } = fakeRenderer();
    const handles: { visible: boolean; disposed: boolean }[] = [];
    const stage = new Stage({
      container,
      store,
      resolveUrl: (_id, ref) => ('path' in ref ? ref.path : ref.hash),
      createRenderer: () => renderer,
      getAdapter: (kind) => (kind === 'mesh' ? (adapter ?? boxAdapter(handles)) : undefined),
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
    expect(stage.quality).toEqual({ maxPixelRatio: 1, shadowMapSize: 1024 });
    stage.dispose();
  });

  it('removes its canvas and stops listening on dispose', () => {
    const { stage, store } = make();
    expect(container.querySelector('canvas')).not.toBeNull();
    stage.dispose();
    expect(container.querySelector('canvas')).toBeNull();
    store.getState().openProject(project([meshLayer('plant')]));
    expect(stage.projectId).toBe('');
  });
});
