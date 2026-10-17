// @vitest-environment jsdom
import { setActiveScene, type SceneHandle } from '@aio/engine';
import type { MapController } from '@aio/maps';
import { workspace } from '@aio/workspace';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the map registry as `@aio/maps` keeps it (its setter is not exported), and the arrows it draws
const maps = vi.hoisted(() => {
  let active: unknown = null;
  const listeners = new Set<(c: unknown) => void>();
  return {
    set(c: unknown) {
      active = c;
      for (const l of listeners) l(c);
    },
    getActiveMap: () => active,
    onActiveMap: (l: (c: unknown) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
});
const setMediaPins = vi.hoisted(() => vi.fn());
vi.mock('@aio/maps', async (load) => ({
  ...(await load<object>()),
  getActiveMap: maps.getActiveMap,
  onActiveMap: maps.onActiveMap,
  setMediaPins,
  removeMediaPins: () => undefined,
}));

const attached = vi.hoisted(() => vi.fn());
vi.mock('./pinScene', () => ({
  attachPinScene: (scene: unknown) => {
    attached(scene);
    return { update: () => undefined, dispose: () => undefined };
  },
}));
vi.mock('../shell', () => ({ shell: { getState: () => ({ stageMode: '3d' }) } }));

const { PinSceneMount } = await import('./PinSceneMount');
const { PinMapMount } = await import('./PinMapMount');

const scene = { scene: { children: [] } } as unknown as SceneHandle;
const map = {
  map: { isStyleLoaded: () => true, once: () => undefined, off: () => undefined },
} as unknown as MapController;

/**
 * The views come up in the same commit as the pin layers: the 3D view sets the active scene in
 * its own effect, after the mounts' first render read none and before their effects listened.
 */
function ViewsComeUp() {
  useLayoutEffect(() => {
    setActiveScene(scene);
    maps.set(map);
  }, []);
  return null;
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  setActiveScene(null);
  maps.set(null);
  attached.mockReset();
  setMediaPins.mockReset();
});

describe('the pin layers on a project that opens straight on the views', () => {
  it('draw in a 3D view and on a map that came up between their first render and effects', () => {
    workspace.setState({
      project: {
        id: 'p',
        manifest: {
          crs: { epsg: 32633 },
          origin: [500000, 5000000, 0],
          captures: [],
          layers: [],
        },
      },
      hidden: {},
    } as unknown as Parameters<typeof workspace.setState>[0]);
    root = createRoot(document.createElement('div'));
    act(() =>
      root?.render(
        <>
          <PinSceneMount />
          <PinMapMount />
          <ViewsComeUp />
        </>,
      ),
    );
    expect(attached).toHaveBeenCalledWith(scene);
    expect(setMediaPins).toHaveBeenCalledWith(map.map, expect.anything());
  });
});
