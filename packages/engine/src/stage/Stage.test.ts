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
});
