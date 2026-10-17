// @vitest-environment jsdom
import { setActiveScene, type SceneHandle } from '@aio/engine';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { Group, Scene } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stagePrefs } from '../workspace/stagePrefs';

type Mode = '3d' | 'map' | 'split';
interface ShellState {
  stageMode: Mode;
  screen: string;
  setStageMode(m: Mode): void;
  go(): void;
}
const sh = vi.hoisted(() => {
  const state: ShellState = {
    stageMode: 'map',
    screen: 'scene',
    setStageMode: (m) => {
      state.stageMode = m;
    },
    go: () => undefined,
  };
  return { state };
});
vi.mock('../shell', () => ({ shell: { getState: () => sh.state } }));

const { arrowPins, openPanoFromMap, showPinArrows, threeDOnScreen } = await import('./PinMapMount');

function project() {
  workspace.setState({
    project: { id: 'p', manifest: { layers: [] } },
  } as unknown as Parameters<typeof workspace.setState>[0]);
}

function fakeScene() {
  const frames = new Set<() => void>();
  const scene = new Scene();
  const h = {
    scene,
    onFrame: (cb: () => void) => {
      frames.add(cb);
      return () => frames.delete(cb);
    },
    requestRender: () => undefined,
  } as unknown as SceneHandle;
  return { h, scene, frames };
}

afterEach(() => {
  setActiveScene(null);
  sh.state.stageMode = 'map';
});

describe('openPanoFromMap', () => {
  it('enters the 360 at once when a 3D view is on screen', () => {
    project();
    sh.state.stageMode = '3d';
    const openPano = vi.spyOn(workspace.getState(), 'openPano');
    expect(threeDOnScreen()).toBe(true);
    openPanoFromMap('pa', 'x');
    expect(openPano).toHaveBeenCalledWith('pa', 'x');
    openPano.mockRestore();
  });

  it('puts the 3D view beside the map and enters once the layer has loaded', () => {
    project();
    sh.state.stageMode = 'map';
    expect(threeDOnScreen()).toBe(false);
    const openPano = vi.spyOn(workspace.getState(), 'openPano');
    openPanoFromMap('pa', 'x');
    expect(sh.state.stageMode).toBe('split');
    expect(stagePrefs.getState().byProject.p?.split).toMatchObject({ left: 'map', right: '3d' });
    expect(openPano).not.toHaveBeenCalled();

    // the 3D view opens, then its panoramas layer loads
    const { h, scene, frames } = fakeScene();
    setActiveScene(h);
    expect(openPano).not.toHaveBeenCalled();
    const g = new Group();
    g.name = 'panoramas:pa';
    scene.add(g);
    for (const f of frames) f();
    expect(openPano).toHaveBeenCalledWith('pa', 'x');
    expect(frames.size).toBe(0);
    openPano.mockRestore();
  });
});

describe('pin arrows on the map', () => {
  const manifest = {
    captures: [],
    layers: [
      {
        kind: 'photos',
        id: 'ph',
        name: 'Photos',
        visible: true,
        items: [
          {
            id: 'aimed',
            src: { path: 'photos/a.jpg' },
            pos: [1, 1.6, 2],
            pin: { ground: [1, 0, 2], eyeM: 1.6, headingDeg: 95 },
          },
          {
            id: 'unaimed',
            src: { path: 'photos/b.jpg' },
            pos: [3, 1.6, 4],
            pin: { ground: [3, 0, 4], eyeM: 1.6 },
          },
          { id: 'gps', src: { path: 'photos/c.jpg' }, pos: [5, 30, 6] },
        ],
      },
    ],
  } as unknown as ProjectManifest;

  it('feeds only the pins that have a heading', () => {
    expect(arrowPins(manifest, new Set())).toEqual([
      { id: 'photo:ph:aimed', kind: 'photo', ground: [1, 0, 2], headingDeg: 95 },
    ]);
    expect(arrowPins(manifest, new Set(['ph']))).toEqual([]);
  });

  it('draws once the map is idle when its style is busy, and not after it stopped', () => {
    const idle: (() => void)[] = [];
    let loaded = false;
    const addSource = vi.fn();
    const map = {
      isStyleLoaded: () => loaded,
      once: (type: string, cb: () => void) => {
        if (type === 'idle') idle.push(cb);
      },
      off: (type: string, cb: () => void) => {
        const i = idle.indexOf(cb);
        if (type === 'idle' && i >= 0) idle.splice(i, 1);
      },
      getSource: () => undefined,
      hasImage: () => false,
      addImage: vi.fn(),
      addSource,
      addLayer: vi.fn(),
    } as unknown as Parameters<typeof showPinArrows>[0];
    const data = { type: 'FeatureCollection', features: [] } as Parameters<typeof showPinArrows>[1];
    showPinArrows(map, data);
    expect(addSource).not.toHaveBeenCalled();
    // still busy at the first idle: waits for the next
    idle.shift()?.();
    expect(addSource).not.toHaveBeenCalled();
    loaded = true;
    idle.shift()?.();
    expect(addSource).toHaveBeenCalledTimes(1);

    // a draw stopped while waiting never lands
    loaded = false;
    const stop = showPinArrows(map, data);
    stop();
    loaded = true;
    for (const f of idle.splice(0)) f();
    expect(addSource).toHaveBeenCalledTimes(1);
  });
});
