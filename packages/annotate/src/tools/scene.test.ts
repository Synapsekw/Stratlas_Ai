import { setActiveScene, type SceneHandle } from '@aio/engine';
import { toWgs84 } from '@aio/geo';
import type { Issue, ProjectManifest, Vec3 } from '@aio/schema';
import { captureIndex, createWorkspace, scopedStore } from '@aio/workspace';
import {
  PerspectiveCamera,
  Scene,
  type BufferGeometry,
  type Points,
  type WebGLRenderer,
} from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogue, linedUp, makeIssue, photoSighting, tankModel } from '../testing';
import type { OcclusionFactory } from './occlusion';
import { createPinDisplay } from './pinDisplay';
import { installIssueOverlay, issueAt, ndcOf } from './scene';

const farSighting = {
  on: 'mesh' as const,
  layer: 'tank',
  geom: {
    type: 'spoint' as const,
    p: [8, 2, 3] as [number, number, number],
    n: [0, 1, 0] as [number, number, number],
  },
};

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [],
  severityModels: [tankModel],
  classCatalogues: [catalogue],
};

function fakeHandle() {
  const frames: ((dt: number) => void)[] = [];
  const el = new EventTarget() as EventTarget & {
    clientHeight: number;
    clientWidth: number;
    style: object;
  };
  el.clientHeight = 600;
  el.clientWidth = 800;
  el.style = {};
  const handle = {
    scene: new Scene(),
    camera: (() => {
      const c = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
      c.position.set(0, 2, 40);
      c.lookAt(0, 2, 0);
      c.updateMatrixWorld();
      return c;
    })(),
    renderer: { domElement: el } as unknown as WebGLRenderer,
    projectId: 'p',
    requestRender: () => undefined,
    onFrame: (cb: (dt: number) => void) => {
      frames.push(cb);
      return () => frames.splice(frames.indexOf(cb), 1);
    },
    holdContinuous: () => () => undefined,
    projectionReceivers: () => [],
    raycast: () => null,
    raycastRay: () => null,
    addRaycastProvider: () => () => undefined,
    clippingPlanes: [],
    addRaycastTarget: () => () => undefined,
    addContentBounds: () => () => undefined,
    addProjectionReceiver: () => () => undefined,
  } satisfies SceneHandle;
  return { handle, frames };
}

const pinGroup = (h: SceneHandle) => h.scene.getObjectByName('annotate-issue-pins');

describe('installIssueOverlay', () => {
  afterEach(() => {
    setActiveScene(null);
  });

  const layoutOf = (h: SceneHandle) =>
    pinGroup(h)?.userData.layout as { items: { kind: string; members: unknown[] }[] } | undefined;
  const frame = (frames: ((dt: number) => void)[]) => {
    frames.forEach((f) => {
      f(16);
    });
  };

  it('pins every issue with a 3D anchor, clusters overlaps and follows changes', () => {
    const store = createWorkspace();
    store
      .getState()
      .openProject({ id: 'p', root: 'r', manifest }, [
        makeIssue(),
        makeIssue({ id: 'b', code: 'F02', sightings: [photoSighting] }),
      ]);
    const display = createPinDisplay(null);
    const uninstall = installIssueOverlay(store, display);
    const { handle, frames } = fakeHandle();
    setActiveScene(handle);
    frame(frames);
    expect(layoutOf(handle)?.items.map((i) => i.kind)).toEqual(['pin']);
    store.getState().upsertIssue(makeIssue({ id: 'c', code: 'F03' }));
    frame(frames);
    // same anchor: one badge for two issues
    expect(layoutOf(handle)?.items.map((i) => [i.kind, i.members.length])).toEqual([
      ['cluster', 2],
    ]);
    const discs = pinGroup(handle)?.getObjectByName('annotate-pin-discs') as Points | undefined;
    expect(discs?.geometry.drawRange.count).toBe(1);
    uninstall();
    expect(pinGroup(handle)).toBeUndefined();
    expect(frames).toHaveLength(0);
  });

  it('follows the pin filter and draws the heat map on request', () => {
    const store = createWorkspace();
    store
      .getState()
      .openProject({ id: 'p', root: 'r', manifest }, [
        makeIssue(),
        makeIssue({ id: 'low', code: 'F02', severity: 1, sightings: [farSighting] }),
      ]);
    const display = createPinDisplay(null);
    const uninstall = installIssueOverlay(store, display);
    const { handle, frames } = fakeHandle();
    setActiveScene(handle);
    frame(frames);
    expect(layoutOf(handle)?.items).toHaveLength(2);
    display.getState().setFilter(3);
    frame(frames);
    expect(layoutOf(handle)?.items).toHaveLength(1);
    display.getState().setFilter('off');
    frame(frames);
    expect(layoutOf(handle)?.items).toHaveLength(0);
    const heat = () =>
      pinGroup(handle)?.getObjectByName('annotate-issue-heat') as Points | undefined;
    expect(heat()?.visible).toBe(false);
    display.getState().setHeat(true);
    frame(frames);
    expect(heat()?.visible).toBe(true);
    expect(heat()?.geometry.drawRange.count).toBe(2);
    uninstall();
  });

  it('drapes polygon map sightings on the ground and outlines the selected one', () => {
    const store = createWorkspace();
    const sq = (lon: number, lat: number) => [
      [lon, lat],
      [lon + 0.0001, lat],
      [lon + 0.0001, lat + 0.0001],
      [lon, lat],
    ];
    store.getState().openProject({ id: 'p', root: 'r', manifest }, [
      makeIssue({
        id: 'm',
        sightings: [
          {
            on: 'map',
            layer: 'ortho',
            geojson: { type: 'Polygon', coordinates: [sq(48.39, 28.71)] },
          },
        ],
      }),
    ]);
    const display = createPinDisplay(null);
    const uninstall = installIssueOverlay(store, display);
    const { handle, frames } = fakeHandle();
    setActiveScene(handle);
    frame(frames);
    const drape = handle.scene.getObjectByName('annotate-map-shapes');
    // outline and fill, no pin (no 3D anchor)
    expect(drape?.children).toHaveLength(2);
    expect(layoutOf(handle)?.items).toHaveLength(0);
    store.getState().select({ kind: 'issue', id: 'm' });
    expect(drape?.children).toHaveLength(3);
    // the pin filter hides the shape too (the selected outline stays)
    display.getState().setFilter('off');
    expect(drape?.children).toHaveLength(1);
    uninstall();
    expect(handle.scene.getObjectByName('annotate-map-shapes')).toBeUndefined();
  });

  it('draws the pins and shapes of a lined-up date at the corrected place', () => {
    const store = createWorkspace();
    const ll = (e: number, n: number) => toWgs84([e, n, 0], 32639).slice(0, 2);
    store.getState().openProject({ id: 'demo', root: 'r', manifest: linedUp }, [
      makeIssue({
        id: 'pin',
        sightings: [
          { on: 'mesh', layer: 'model-d2', geom: { type: 'spoint', p: [0, 2, 0], n: [0, 1, 0] } },
        ],
      }),
      makeIssue({
        id: 'shape',
        code: 'F02',
        sightings: [
          {
            on: 'map',
            layer: 'ortho-d2',
            geojson: {
              type: 'Polygon',
              coordinates: [
                [
                  ll(500010, 3200005),
                  ll(500011, 3200005),
                  ll(500011, 3200006),
                  ll(500010, 3200005),
                ],
              ],
            },
          },
        ],
      }),
    ]);
    const uninstall = installIssueOverlay(store, createPinDisplay(null));
    const { handle, frames } = fakeHandle();
    setActiveScene(handle);
    frame(frames);
    const discs = pinGroup(handle)?.getObjectByName('annotate-pin-discs') as Points | undefined;
    const pos = discs?.geometry.getAttribute('position');
    expect([pos?.getX(0), pos?.getY(0), pos?.getZ(0)]).toEqual([2, 2, 0]);
    const lines = handle.scene
      .getObjectByName('annotate-map-shapes')
      ?.children.find((c) => (c as { isLineSegments?: boolean }).isLineSegments) as
      Points | undefined;
    const first = lines?.geometry.getAttribute('position');
    expect(first?.getX(0)).toBeCloseTo(12, 2);
    expect(first?.getZ(0)).toBeCloseTo(-5, 2);
    uninstall();
  });

  it('leaves occluded pins out of the view and the badges, and follows new snapshots', () => {
    const store = createWorkspace();
    store
      .getState()
      .openProject({ id: 'p', root: 'r', manifest }, [
        makeIssue(),
        makeIssue({ id: 'c', code: 'F03' }),
        makeIssue({ id: 'far', code: 'F04', sightings: [farSighting] }),
      ]);
    // the stand-in hides every pin with x < 5 (the "back face") until told otherwise
    let hideBack = true;
    let update: () => void = () => undefined;
    let frames = 0;
    const occlusion: OcclusionFactory = (_h, skip, onUpdate) => {
      expect(skip.name).toBe('annotate-issue-pins');
      update = onUpdate;
      return {
        frame: () => {
          frames++;
        },
        clear: (p) => !hideBack || p[0] >= 5,
        dispose: () => undefined,
      };
    };
    const { handle, frames: cbs } = fakeHandle();
    setActiveScene(handle);
    const uninstall = installIssueOverlay(store, createPinDisplay(null), { occlusion });
    frame(cbs);
    expect(frames).toBe(1);
    const shown = () =>
      layoutOf(handle)?.items.flatMap((i) =>
        (i.members as { issueId: string }[]).map((m) => m.issueId),
      );
    // makeIssue's anchor is on the back: only the far-side pin remains, no badge
    expect(shown()).toEqual(['far']);
    expect(layoutOf(handle)?.items.map((i) => i.kind)).toEqual(['pin']);
    // the selected issue shows wherever it is
    store.getState().select({ kind: 'issue', id: 'c' });
    frame(cbs);
    expect(shown()?.sort()).toEqual(['c', 'far']);
    // a new snapshot (the camera came round) brings the others back
    hideBack = false;
    update();
    frame(cbs);
    expect(shown()?.sort()).toEqual(['c', 'far', 'i1']);
    uninstall();
  });

  it('hides the pins, heat and shapes of a survey date with its layers', () => {
    const model = (id: string, capture: string): ProjectManifest['layers'][number] => ({
      kind: 'mesh',
      id,
      name: id,
      visible: true,
      src: { path: `models/${id}.glb` },
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      capture,
    });
    const dated: ProjectManifest = {
      ...manifest,
      captures: [
        { id: 'sep', label: 'September', date: '2024-09-04' },
        { id: 'oct', label: 'October', date: '2024-10-02' },
      ],
      layers: [model('tank', 'sep'), model('tank-oct', 'oct')],
    };
    const octSighting = { ...farSighting, layer: 'tank-oct' };
    const square = [
      [0, 0],
      [0.0001, 0],
      [0.0001, 0.0001],
      [0, 0],
    ];
    const store = createWorkspace();
    store.getState().openProject({ id: 'p', root: 'r', manifest: dated }, [
      makeIssue({ id: 'sep-1' }),
      makeIssue({ id: 'oct-1', code: 'F02', sightings: [octSighting] }),
      // a map shape that belongs to September only by its capture field
      makeIssue({
        id: 'sep-shape',
        code: 'F03',
        capture: 'sep',
        sightings: [
          { on: 'map', layer: 'basemap', geojson: { type: 'Polygon', coordinates: [square] } },
        ],
      }),
    ]);
    store.getState().setDates(captureIndex(dated));
    const display = createPinDisplay(null);
    display.getState().setHeat(true);
    const uninstall = installIssueOverlay(store, display);
    const { handle, frames } = fakeHandle();
    setActiveScene(handle);
    const pinned = () => {
      frame(frames);
      return layoutOf(handle)
        ?.items.flatMap((i) => (i.members as { issueId: string }[]).map((m) => m.issueId))
        .sort();
    };
    const heat = () =>
      pinGroup(handle)?.getObjectByName('annotate-issue-heat') as Points | undefined;
    const drape = () => handle.scene.getObjectByName('annotate-map-shapes');
    expect(pinned()).toEqual(['oct-1', 'sep-1']);
    expect(drape()?.children).toHaveLength(2);

    // the folder eye of September: its pin, its heat and its shape go; October stays
    store.getState().setLayersVisible(['tank'], false);
    expect(pinned()).toEqual(['oct-1']);
    expect(heat()?.geometry.drawRange.count).toBe(1);
    expect(drape()?.children).toHaveLength(0);
    // selecting a hidden date's issue does not bring its pin back
    store.getState().select({ kind: 'issue', id: 'sep-1' });
    expect(pinned()).toEqual(['oct-1']);
    store.getState().select(null);

    store.getState().setLayersVisible(['tank'], true);
    expect(pinned()).toEqual(['oct-1', 'sep-1']);
    expect(heat()?.geometry.drawRange.count).toBe(2);
    expect(drape()?.children).toHaveLength(2);

    // a view of one date (comparing two dates) draws that date's issues only
    uninstall();
    const left = scopedStore(store, {
      capture: 'sep',
      index: captureIndex(dated),
      mode: 'hide',
      camera: true,
    });
    const offLeft = installIssueOverlay(left, display, { scene: handle });
    expect(pinned()).toEqual(['sep-1']);
    left.setScope({ capture: 'oct', index: captureIndex(dated), mode: 'hide', camera: true });
    expect(pinned()).toEqual(['oct-1']);
    offLeft();
  });

  it('draws a placed area instead of its pin, hovers and picks its issue', () => {
    // a 4 x 4 m outline facing the camera, centred on the view (0, 2, 0)
    const ring: Vec3[] = [
      [-2, 0, 0],
      [2, 0, 0],
      [2, 4, 0],
      [-2, 4, 0],
    ];
    const placed: Issue = makeIssue({
      id: 'placed',
      title: 'Crack on the shell',
      sightings: [
        photoSighting,
        {
          on: 'mesh',
          layer: 'tank',
          geom: { type: 'spolygon', points: ring },
          from: { sighting: 0 },
        },
      ],
    });
    const store = createWorkspace();
    store.getState().openProject({ id: 'p', root: 'r', manifest }, [placed]);
    const uninstall = installIssueOverlay(store, createPinDisplay(null));
    const { handle, frames } = fakeHandle();
    setActiveScene(handle);
    frame(frames);
    expect(layoutOf(handle)?.items).toEqual([]);
    const areas = pinGroup(handle)?.getObjectByName('annotate-issue-areas');
    expect(areas?.visible).toBe(true);
    const lines = areas?.getObjectByName('annotate-area-lines') as
      { geometry: BufferGeometry } | undefined;
    expect(lines?.geometry.getAttribute('position').count).toBe(8);
    const at = (pinGroup(handle)?.userData.areas as { issueId: string; x: number; y: number }[])[0];
    expect(at?.issueId).toBe('placed');
    expect(at?.x).toBeCloseTo(400, 0);
    expect(at?.y).toBeCloseTo(300, 0);
    const el = handle.renderer.domElement as unknown as EventTarget & { title: string };
    const ev = (type: string) =>
      Object.assign(new Event(type), { button: 0, buttons: 0, clientX: 400, clientY: 300 });
    el.dispatchEvent(ev('pointermove'));
    expect(el.title).toBe('Crack on the shell');
    el.dispatchEvent(ev('pointerdown'));
    el.dispatchEvent(ev('pointerup'));
    expect(store.getState().selection).toEqual({ kind: 'issue', id: 'placed' });
    // its layer hidden: the area goes and the pin comes back
    store.getState().setLayerVisible('tank', false);
    frame(frames);
    expect(layoutOf(handle)?.items.map((i) => i.kind)).toEqual(['pin']);
    uninstall();
  });

  describe('placed areas and the model', () => {
    const placedIssue = (half: number) =>
      makeIssue({
        id: 'placed',
        title: 'Crack on the shell',
        sightings: [
          photoSighting,
          {
            on: 'mesh',
            layer: 'tank',
            geom: {
              type: 'spolygon',
              points: [
                [-half, 0, 0],
                [half, 0, 0],
                [half, 2 * half, 0],
                [-half, 2 * half, 0],
              ],
            },
            from: { sighting: 0 },
          },
        ],
      });
    const rig = (
      half: number,
      clear: () => boolean,
      issue: Issue = placedIssue(half),
      aim?: (cam: PerspectiveCamera) => void,
    ) => {
      const store = createWorkspace();
      store.getState().openProject({ id: 'p', root: 'r', manifest }, [issue]);
      let update: () => void = () => undefined;
      let snaps = 0;
      const occlusion: OcclusionFactory = (_h, _s, onUpdate) => {
        update = onUpdate;
        return {
          frame: () => {
            snaps++;
          },
          clear: () => clear(),
          dispose: () => undefined,
        };
      };
      const { handle, frames } = fakeHandle();
      aim?.(handle.camera);
      setActiveScene(handle);
      const uninstall = installIssueOverlay(store, createPinDisplay(null), { occlusion });
      frame(frames);
      const el = handle.renderer.domElement as unknown as EventTarget & { title: string };
      const ev = (type: string) =>
        Object.assign(new Event(type), { button: 0, buttons: 0, clientX: 400, clientY: 300 });
      return {
        store,
        handle,
        frames,
        el,
        ev,
        uninstall,
        snaps: () => snaps,
        update: () => {
          update();
        },
      };
    };

    it('does not hover or pick an area on the far side of the model', () => {
      let front = false;
      const r = rig(2, () => front);
      r.el.dispatchEvent(r.ev('pointermove'));
      expect(r.el.title).toBe('');
      r.el.dispatchEvent(r.ev('pointerdown'));
      r.el.dispatchEvent(r.ev('pointerup'));
      expect(r.store.getState().selection).toBeNull();
      front = true;
      r.update();
      frame(r.frames);
      r.el.dispatchEvent(r.ev('pointermove'));
      expect(r.el.title).toBe('Crack on the shell');
      r.el.dispatchEvent(r.ev('pointerdown'));
      r.el.dispatchEvent(r.ev('pointerup'));
      expect(r.store.getState().selection).toEqual({ kind: 'issue', id: 'placed' });
      r.uninstall();
    });

    it('still hits an area whose corners are off screen', () => {
      // 200 m wide: every corner is far outside the 800 x 600 view, the pointer is inside
      const r = rig(100, () => true);
      r.el.dispatchEvent(r.ev('pointermove'));
      expect(r.el.title).toBe('Crack on the shell');
      r.el.dispatchEvent(r.ev('pointerdown'));
      r.el.dispatchEvent(r.ev('pointerup'));
      expect(r.store.getState().selection).toEqual({ kind: 'issue', id: 'placed' });
      r.uninstall();
    });

    it('hits the visible part of a ground patch that runs behind the camera', () => {
      // 200 m patch, camera 10 m above its middle looking forward and down: the back corners
      // are behind the camera
      const patch = makeIssue({
        id: 'placed',
        title: 'Crack on the shell',
        sightings: [
          photoSighting,
          {
            on: 'mesh',
            layer: 'tank',
            geom: {
              type: 'spolygon',
              points: [
                [-100, 0, -100],
                [100, 0, -100],
                [100, 0, 100],
                [-100, 0, 100],
              ],
            },
            from: { sighting: 0 },
          },
        ],
      });
      const r = rig(
        100,
        () => true,
        patch,
        (cam) => {
          cam.position.set(0, 10, 0);
          cam.lookAt(0, 0, -30);
          cam.updateMatrixWorld();
        },
      );
      r.el.dispatchEvent(r.ev('pointermove'));
      expect(r.el.title).toBe('Crack on the shell');
      r.el.dispatchEvent(r.ev('pointerdown'));
      r.el.dispatchEvent(r.ev('pointerup'));
      expect(r.store.getState().selection).toEqual({ kind: 'issue', id: 'placed' });
      r.uninstall();
    });

    it('keeps the depth snapshot fresh while only areas are drawn', () => {
      const r = rig(2, () => true);
      expect(r.snaps()).toBe(1);
      r.uninstall();
    });

    it('frees the old geometries when the areas are rebuilt', () => {
      const r = rig(2, () => true);
      const group = r.handle.scene.getObjectByName('annotate-issue-pins');
      const lines = group?.getObjectByName('annotate-area-lines') as
        { geometry: BufferGeometry } | undefined;
      const old = lines?.geometry;
      let disposed = 0;
      old?.addEventListener('dispose', () => {
        disposed++;
      });
      r.store.getState().select({ kind: 'issue', id: 'placed' });
      expect(disposed).toBe(1);
      expect(lines?.geometry).not.toBe(old);
      r.uninstall();
    });
  });

  it('tells another tool on the canvas which issue pin is under the cursor', () => {
    const store = createWorkspace();
    store.getState().openProject({ id: 'p', root: 'r', manifest }, [makeIssue()]);
    const uninstall = installIssueOverlay(store, createPinDisplay(null));
    const { handle, frames } = fakeHandle();
    setActiveScene(handle);
    frame(frames);
    const pin = layoutOf(handle)?.items[0] as { x: number; y: number } | undefined;
    if (!pin) throw new Error('no pin');
    const el = handle.renderer.domElement;
    expect(issueAt(el, pin.x, pin.y)).toBe(makeIssue().id);
    expect(issueAt(el, pin.x + 200, pin.y)).toBeNull();
    uninstall();
    expect(issueAt(el, pin.x, pin.y)).toBeNull();
  });

  it('attaches to a scene that was already active', () => {
    const store = createWorkspace();
    store.getState().openProject({ id: 'p', root: 'r', manifest }, [makeIssue()]);
    const { handle } = fakeHandle();
    setActiveScene(handle);
    const uninstall = installIssueOverlay(store, createPinDisplay(null));
    expect(pinGroup(handle)).toBeDefined();
    uninstall();
  });
});

describe('ndcOf', () => {
  it('maps client pixels to normalised device coordinates', () => {
    const el = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) };
    expect(ndcOf({ clientX: 110, clientY: 70 }, el as unknown as Element)).toEqual([0, 0]);
    expect(ndcOf({ clientX: 10, clientY: 20 }, el as unknown as Element)).toEqual([-1, 1]);
  });
});
