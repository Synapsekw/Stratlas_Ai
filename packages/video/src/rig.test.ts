// @vitest-environment jsdom
import type { SceneHandle } from '@aio/engine';
import type { Layer, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { Line, PerspectiveCamera, Scene, type Mesh, type WebGLRenderer } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFlightPaths, VideoRig } from './rig';
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

function handle(frames: ((dtMs: number) => void)[] = []): SceneHandle {
  return {
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    renderer: {} as WebGLRenderer,
    projectId: 'p',
    requestRender: () => undefined,
    onFrame: (fn) => {
      frames.push(fn);
      return () => undefined;
    },
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

  it('shows every, only the active or no flight path, and hides single flights', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(flight)))),
    );
    const clips = [clip(0, 'flights/a.json'), clip(1, 'flights/a.json'), clip(2, 'flights/b.json')];
    const store = createWorkspace();
    const manifest = { layers: clips } as unknown as ProjectManifest;
    store.getState().openProject({ id: 'p', root: 'x', manifest });
    store.getState().setActiveClip(null);
    configureVideo({ store, resolveUrl: (_p, ref) => ('path' in ref ? ref.path : ref.hash) });
    const frames: ((dtMs: number) => void)[] = [];
    const rig = new VideoRig(handle(frames));
    const ctx = {
      scene: rig.handle,
      url: (r: { path: string } | { hash: string }) => ('path' in r ? `aio://${r.path}` : r.hash),
    };
    await Promise.all(clips.map((c) => rig.addLayer(c, ctx)));
    const shown = () => {
      for (const f of frames) f(16);
      return lines(rig)
        .filter((l) => l.visible)
        .map((l) => String(l.userData.videoLayer))
        .sort();
    };
    expect(shown()).toEqual(['v0', 'v2']);

    store.getState().setActiveClip('v1');
    rig.setFlightPaths({ mode: 'active' });
    expect(shown()).toEqual(['v0']); // the path of flight a, which holds v1
    rig.setFlightPaths({ mode: 'off' });
    expect(shown()).toEqual([]);
    // the clips themselves stay available: paths off never hides a layer
    expect(store.getState().hidden).toEqual({});

    rig.setFlightPaths({ mode: 'all', hiddenClips: new Set(['v2']) });
    expect(shown()).toEqual(['v0']);
    rig.setFlightPaths({ mode: 'all', hiddenClips: new Set() });
    expect(shown()).toEqual(['v0', 'v2']);
    rig.dispose();
  });

  it('keeps the path choice for a scene across rigs (a new project builds a new rig)', () => {
    const h = handle();
    setFlightPaths(h, { mode: 'off', hiddenClips: new Set(['v1']) });
    const rig = new VideoRig(h);
    expect(rig.flightPaths.mode).toBe('off');
    expect([...rig.flightPaths.hiddenClips]).toEqual(['v1']);
    rig.dispose();
  });
});
