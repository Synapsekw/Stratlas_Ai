import { setActiveScene, type SceneHandle } from '@aio/engine';
import type { ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { PerspectiveCamera, Scene, type Points, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogue, makeIssue, photoSighting, tankModel } from '../testing';
import { createPinDisplay } from './pinDisplay';
import { installIssueOverlay, ndcOf } from './scene';

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
