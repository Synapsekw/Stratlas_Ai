// @vitest-environment jsdom
import type { SceneHandle } from '@aio/engine';
import type { Layer, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { Line, PerspectiveCamera, Scene, type Mesh, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoRig } from './rig';
import { configureVideo } from './runtime';

const flight = {
  schema: 'aio.flight/1',
  startUtcMs: 1_700_000_000_000,
  lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
  samples: [
    { t: 0, pos: [0, 1, 0], q: [0, 0, 0, 1] },
    { t: 1000, pos: [1, 1, 0], q: [0, 0, 0, 1] },
  ],
};

const clip = (n: number, file: string): Extract<Layer, { kind: 'video' }> => ({
  kind: 'video',
  id: `v${String(n)}`,
  name: `clip ${String(n)}`,
  visible: true,
  src: { path: `video/v${String(n)}.mp4` },
  flight: { src: { path: file }, startUtcMs: flight.startUtcMs },
  lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
  offsetMs: n * 60_000,
});

function handle(): SceneHandle {
  return {
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    renderer: {} as WebGLRenderer,
    projectId: 'p',
    requestRender: () => undefined,
    onFrame: () => () => undefined,
    holdContinuous: () => () => undefined,
    projectionReceivers: (): Mesh[] => [],
    raycast: () => null,
    raycastRay: () => null,
    addRaycastProvider: () => () => undefined,
    clippingPlanes: [],
    addRaycastTarget: () => () => undefined,
    addProjectionReceiver: () => () => undefined,
  };
}

const lines = (rig: VideoRig) =>
  rig.group.children.filter((o) => o instanceof Line && o.userData.videoLayer !== undefined);

describe('VideoRig flight paths', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws one path per flight log, however many clips were cut from it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(flight)))),
    );
    const store = createWorkspace();
    const manifest = { layers: [] } as unknown as ProjectManifest;
    store.getState().openProject({ id: 'p', root: 'x', manifest });
    store.getState().setActiveClip(null);
    configureVideo({ store, resolveUrl: (_p, ref) => ('path' in ref ? ref.path : ref.hash) });
    const rig = new VideoRig(handle());
    const ctx = {
      scene: rig.handle,
      url: (r: { path: string } | { hash: string }) => ('path' in r ? `aio://${r.path}` : r.hash),
    };
    await Promise.all([
      rig.addLayer(clip(0, 'flights/a.json'), ctx),
      rig.addLayer(clip(1, 'flights/a.json'), ctx),
      rig.addLayer(clip(2, 'flights/b.json'), ctx),
    ]);
    expect(lines(rig)).toHaveLength(2);
    rig.removeLayer('v0');
    expect(lines(rig)).toHaveLength(2);
    rig.removeLayer('v1');
    expect(lines(rig)).toHaveLength(1);
    rig.dispose();
  });
});
