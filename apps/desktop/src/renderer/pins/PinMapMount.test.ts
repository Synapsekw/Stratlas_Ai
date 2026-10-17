// @vitest-environment jsdom
import { setActiveScene, type SceneHandle } from '@aio/engine';
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

const { openPanoFromMap, threeDOnScreen } = await import('./PinMapMount');

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
