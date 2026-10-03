import { setActiveScene, type SceneHandle } from '@aio/engine';
import type { ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { catalogue, makeIssue, photoSighting, tankModel } from '../testing';
import { installIssueOverlay, ndcOf } from './scene';

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
  const el = new EventTarget() as EventTarget & { clientHeight: number; style: object };
  el.clientHeight = 600;
  el.style = {};
  const handle = {
    scene: new Scene(),
    camera: new PerspectiveCamera(50, 1, 0.1, 1000),
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

  it('pins every issue with a 3D anchor and follows changes', () => {
    const store = createWorkspace();
    store
      .getState()
      .openProject({ id: 'p', root: 'r', manifest }, [
        makeIssue(),
        makeIssue({ id: 'b', code: 'F02', sightings: [photoSighting] }),
      ]);
    const uninstall = installIssueOverlay(store);
    const { handle, frames } = fakeHandle();
    setActiveScene(handle);
    expect(pinGroup(handle)?.children).toHaveLength(1);
    store.getState().upsertIssue(makeIssue({ id: 'c', code: 'F03' }));
    expect(pinGroup(handle)?.children).toHaveLength(2);
    frames.forEach((f) => {
      f(16);
    });
    expect(pinGroup(handle)?.children[0]?.children[0]?.scale.x).toBeGreaterThan(0);
    uninstall();
    expect(pinGroup(handle)).toBeUndefined();
    expect(frames).toHaveLength(0);
  });

  it('attaches to a scene that was already active', () => {
    const store = createWorkspace();
    store.getState().openProject({ id: 'p', root: 'r', manifest }, [makeIssue()]);
    const { handle } = fakeHandle();
    setActiveScene(handle);
    const uninstall = installIssueOverlay(store);
    expect(pinGroup(handle)?.children).toHaveLength(1);
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
