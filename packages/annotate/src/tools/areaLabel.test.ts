// @vitest-environment jsdom
import { setActiveScene, type SceneHandle } from '@aio/engine';
import type { ProjectManifest, Vec3 } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { afterEach, expect, it } from 'vitest';
import { catalogue, makeIssue, photoSighting, tankModel } from '../testing';
import { createPinDisplay } from './pinDisplay';
import { installIssueOverlay } from './scene';

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

afterEach(() => {
  setActiveScene(null);
});

it('shows the issue title while the pointer is over the code label of an area', () => {
  const host = document.createElement('div');
  const el = document.createElement('canvas');
  Object.defineProperty(el, 'clientWidth', { value: 800 });
  Object.defineProperty(el, 'clientHeight', { value: 600 });
  host.append(el);
  const frames: ((dt: number) => void)[] = [];
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  camera.position.set(0, 2, 40);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld();
  const handle = {
    scene: new Scene(),
    camera,
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
  const ring: Vec3[] = [
    [-2, 0, 0],
    [2, 0, 0],
    [2, 4, 0],
    [-2, 4, 0],
  ];
  const store = createWorkspace();
  store.getState().openProject({ id: 'p', root: 'r', manifest }, [
    makeIssue({
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
    }),
  ]);
  const uninstall = installIssueOverlay(store, createPinDisplay(null));
  setActiveScene(handle);
  frames.forEach((f) => {
    f(16);
  });
  const label = host.querySelector<HTMLElement>('.ann-pin-labels [data-kind="code"]');
  expect(label?.dataset.key).toBe('placed');
  // the code label sits on the area centre and wins the hit test
  if (label)
    label.getBoundingClientRect = () =>
      ({ left: 380, right: 420, top: 290, bottom: 310 }) as DOMRect;
  el.dispatchEvent(
    Object.assign(new Event('pointermove'), { button: 0, buttons: 0, clientX: 400, clientY: 300 }),
  );
  expect(el.title).toBe('Crack on the shell');
  uninstall();
});
