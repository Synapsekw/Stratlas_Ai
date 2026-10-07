// @vitest-environment jsdom
import type { SceneHandle } from '@aio/engine';
import type { Layer, ProjectManifest } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import {
  Line,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  type Mesh,
  type WebGLRenderer,
} from 'three';
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
    addContentBounds: () => () => undefined,
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

  it('draws the telemetry trace of the active clip whatever the paths, and turns it off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(flight)))),
    );
    const clips = [clip(0, 'flights/a.json'), clip(1, 'flights/b.json')];
    const store = createWorkspace();
    const manifest = { layers: clips, origin: [0, 0, 100] } as unknown as ProjectManifest;
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
    const step = () => {
      for (const f of frames) f(16);
    };
    const activePath = () =>
      lines(rig).find((l) => l.userData.videoLayer === 'v0') as Line | undefined;
    store.getState().setActiveClip('v0');
    store.getState().setTime(flight.startUtcMs + 500);
    step();
    expect(rig.trace.group.visible).toBe(true);
    // the trace leads: the active flight's path steps back
    expect((activePath()?.material as { opacity: number }).opacity).toBeLessThan(1);
    rig.setFlightPaths({ mode: 'off' });
    step();
    expect(rig.trace.group.visible).toBe(true);
    rig.setDroneTelemetry({ on: false });
    step();
    expect(rig.trace.group.visible).toBe(false);
    expect(rig.droneTelemetry).toBe(false);
    expect((activePath()?.material as { opacity: number }).opacity).toBe(1);
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

describe('VideoRig drone-eye', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the orbit target on the ground the drone films, not a metre ahead of the lens', async () => {
    // 120 m up, camera pitched 45 degrees down: the view ray meets the ground ~170 m away. The
    // stage derives near / far, the shadow frustum and the ortho tile LOD from the distance to
    // the orbit target; a target 1 m ahead gave a near plane of 1 cm against a 58 km far plane on
    // Al-Zour, and the sea plane z-fought through the plant and the ortho (flicker).
    const s = Math.sin(-Math.PI / 8);
    const c = Math.cos(Math.PI / 8);
    const high = {
      ...flight,
      lens: { model: 'pinhole', hfovDeg: 80, aspect: 1.7778 },
      samples: [
        { t: 0, pos: [0, 120, 0], q: [s, 0, 0, c] },
        { t: 10_000, pos: [10, 120, 0], q: [s, 0, 0, c] },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(high)))),
    );
    const layer = {
      ...clip(0, 'flights/high.json'),
      lens: { model: 'pinhole' as const, hfovDeg: 80, aspect: 1.7778 },
      offsetMs: 0,
    };
    const store = createWorkspace();
    const manifest = { layers: [layer] } as unknown as ProjectManifest;
    store.getState().openProject({ id: 'p', root: 'x', manifest });
    configureVideo({ store, resolveUrl: (_p, ref) => ('path' in ref ? ref.path : ref.hash) });
    const frames: (() => void)[] = [];
    const controls = { target: new Vector3(), enabled: true };
    const h = Object.assign(handle(), {
      controls,
      onFrame: (cb: () => void) => {
        frames.push(cb);
        return () => undefined;
      },
    });
    const rig = new VideoRig(h);
    await rig.addLayer(layer, { scene: h, url: (r) => ('path' in r ? r.path : r.hash) });
    store.getState().setActiveClip(layer.id);
    store.getState().setTime(high.startUtcMs + 2_000);
    rig.setCameraMode('drone');
    for (const f of frames) f();

    const cam = h.camera;
    expect(cam.position.y).toBeCloseTo(120);
    const toTarget = controls.target.clone().sub(cam.position);
    const look = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    // on the view axis, at the ground
    expect(toTarget.clone().normalize().dot(look)).toBeCloseTo(1, 5);
    expect(controls.target.y).toBeCloseTo(0, 3);
    expect(toTarget.length()).toBeCloseTo(120 / Math.sin(Math.PI / 4), 1);
    rig.dispose();
  });

  it('tries a calibration lens on the drone-eye camera and restores the clip lens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(flight)))),
    );
    const layer = {
      ...clip(0, 'flights/cal.json'),
      lens: { model: 'pinhole' as const, hfovDeg: 80, aspect: 2 },
      offsetMs: 0,
    };
    const store = createWorkspace();
    store.getState().openProject({
      id: 'p',
      root: 'x',
      manifest: { layers: [layer] } as unknown as ProjectManifest,
    });
    configureVideo({ store, resolveUrl: (_p, ref) => ('path' in ref ? ref.path : ref.hash) });
    const frames: (() => void)[] = [];
    const h = Object.assign(handle(), {
      onFrame: (cb: () => void) => {
        frames.push(cb);
        return () => undefined;
      },
    });
    const rig = new VideoRig(h);
    await rig.addLayer(layer, { scene: h, url: (r) => ('path' in r ? r.path : r.hash) });
    store.getState().setActiveClip(layer.id);
    store.getState().setTime(flight.startUtcMs + 500);
    rig.setCameraMode('drone');
    const vfov = (hfov: number) =>
      (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / 2) * 180) / Math.PI;
    for (const f of frames) f();
    expect(h.camera.fov).toBeCloseTo(vfov(80), 3);
    rig.setLensOverride({ model: 'pinhole', hfovDeg: 70, aspect: 2 });
    for (const f of frames) f();
    expect(h.camera.fov).toBeCloseTo(vfov(70), 3);
    rig.setLensOverride(null);
    for (const f of frames) f();
    expect(h.camera.fov).toBeCloseTo(vfov(80), 3);
    rig.dispose();
  });

  it('points the camera by direction keyframes, an unsaved draft first, over the bias', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(flight)))),
    );
    const layer = {
      ...clip(0, 'flights/dir.json'),
      lens: { model: 'pinhole' as const, hfovDeg: 80, aspect: 2 },
      offsetMs: 0,
      orientation: { yawDeg: 30, pitchDeg: 0, rollDeg: 0 },
    };
    const store = createWorkspace();
    store.getState().openProject({
      id: 'p',
      root: 'x',
      manifest: { layers: [layer] } as unknown as ProjectManifest,
    });
    // the saved keyframes, from the project's orientation.json
    store.getState().setOrientation({
      schema: 'aio.orientation/1',
      clips: {
        [layer.id]: {
          keys: [
            { t: 0, yaw: 90, pitch: -30, roll: 0, fill: 'smooth' },
            { t: 1000, yaw: 130, pitch: -30, roll: 0, fill: 'smooth' },
          ],
        },
      },
      photos: {},
    });
    configureVideo({ store, resolveUrl: (_p, ref) => ('path' in ref ? ref.path : ref.hash) });
    const frames: (() => void)[] = [];
    const h = Object.assign(handle(), {
      onFrame: (cb: () => void) => {
        frames.push(cb);
        return () => undefined;
      },
    });
    const rig = new VideoRig(h);
    await rig.addLayer(layer, { scene: h, url: (r) => ('path' in r ? r.path : r.hash) });
    store.getState().setActiveClip(layer.id);
    store.getState().setTime(flight.startUtcMs + 500);
    const heading = () => {
      for (const f of frames) f();
      const q = rig.currentPose()?.q;
      const d = new Vector3(0, 0, -1).applyQuaternion(q ?? new Quaternion());
      return ((Math.atan2(d.x, -d.z) * 180) / Math.PI + 360) % 360;
    };
    // half way between 90 and 130; the calibration bias does not apply
    expect(heading()).toBeCloseTo(110, 3);
    // the logged pose stays what the flight file says
    expect(rig.loggedPose()?.q).toEqual([0, 0, 0, 1]);
    store.getState().setDirectionDraft({
      layerId: layer.id,
      keys: [{ t: 0, yaw: 200, pitch: -30, roll: 0, fill: 'smooth' }],
    });
    expect(heading()).toBeCloseTo(200, 3);
    store.getState().setDirectionDraft({ layerId: layer.id, keys: [] });
    // no keyframes in the draft: the log (looking north) turned left by the 30 degree bias
    expect(heading()).toBeCloseTo(330, 3);
    store.getState().setDirectionDraft(null);
    expect(heading()).toBeCloseTo(110, 3);
    rig.dispose();
  });
});
