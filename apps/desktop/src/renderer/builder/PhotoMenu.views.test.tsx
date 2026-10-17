// @vitest-environment jsdom
import { setActiveScene, type SceneHandle } from '@aio/engine';
import type { MapController } from '@aio/maps';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// the map registry as `@aio/maps` keeps it (its setter is not exported)
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
vi.mock('@aio/maps', async (load) => ({
  ...(await load<object>()),
  getActiveMap: maps.getActiveMap,
  onActiveMap: maps.onActiveMap,
}));

const { useMap, useScene } = await import('./activeViews');

const scene = { scene: { children: [] } } as unknown as SceneHandle;
const map = { map: {} } as unknown as MapController;

/** What the hooks return, drawn as text. */
function Probe() {
  const s = useScene();
  const m = useMap();
  return (
    <span data-testid="probe">
      {s === scene ? 'scene' : 'no scene'} {m === map ? 'map' : 'no map'}
    </span>
  );
}

/**
 * The views come up in the same commit as the menus: the 3D view sets the active scene in its
 * own effect, after the menu's first render read none and before the menu's effect listened.
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
});

describe('the views the photo and pin menus listen on', () => {
  it('sees a 3D view and a map that came up between its first render and its effects', () => {
    const host = document.createElement('div');
    root = createRoot(host);
    act(() =>
      root?.render(
        <>
          <Probe />
          <ViewsComeUp />
        </>,
      ),
    );
    expect(host.textContent).toBe('scene map');
  });

  it('follows the views as they change later', () => {
    const host = document.createElement('div');
    root = createRoot(host);
    act(() => root?.render(<Probe />));
    expect(host.textContent).toBe('no scene no map');
    act(() => {
      setActiveScene(scene);
      maps.set(map);
    });
    expect(host.textContent).toBe('scene map');
    act(() => {
      setActiveScene(null);
    });
    expect(host.textContent).toBe('no scene map');
  });
});
