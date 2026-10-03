// @vitest-environment jsdom
import type { Layer, ProjectManifest } from '@aio/schema';
import { createWorkspace, type OpenProject } from '@aio/workspace';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type WebGLRenderer } from 'three';
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

  it('raycasts against content first and the ground plane otherwise', async () => {
    const { stage, store, resize } = make();
    resize(800, 600);
    store.getState().openProject(project([meshLayer('plant')]));
    await flush();
    expect(stage.raycast(0, 0)?.object.type).toBe('Mesh');
    const ground = stage.raycast(0, -0.9);
    expect(ground?.point.y).toBeCloseTo(0, 6);
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

  it('removes its canvas and stops listening on dispose', () => {
    const { stage, store } = make();
    expect(container.querySelector('canvas')).not.toBeNull();
    stage.dispose();
    expect(container.querySelector('canvas')).toBeNull();
    store.getState().openProject(project([meshLayer('plant')]));
    expect(stage.projectId).toBe('');
  });
});
