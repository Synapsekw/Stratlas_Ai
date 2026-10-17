// @vitest-environment jsdom
import type { Vec3 } from '@aio/schema';
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

const { createPinStore } = await import('./pinStore');
const { usePinPicking } = await import('./placePin');

const picks: ((local: Vec3) => void)[] = [];
const map = {
  pickPoint: (onPick: (local: Vec3) => void) => {
    picks.push(onPick);
    return () => undefined;
  },
};

/** The map comes up in the same commit: set in its own effect, before the hook's effects listen. */
function MapComesUp() {
  useLayoutEffect(() => {
    maps.set(map);
  }, []);
  return null;
}

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  maps.set(null);
  picks.length = 0;
});

describe('placing a pin on a project that opens straight on the map', () => {
  it('arms the map that came up between the first render and the effects', () => {
    const store = createPinStore({
      manifest: () => null,
      save: () => Promise.resolve(null),
      openPanoBeside: vi.fn(),
    });
    store.setState({ target: { kind: 'photo', layerId: 'photos', itemId: 'a' }, step: 'pick' });
    function Picking() {
      usePinPicking(store);
      return null;
    }
    root = createRoot(document.createElement('div'));
    act(() =>
      root?.render(
        <>
          <Picking />
          <MapComesUp />
        </>,
      ),
    );
    expect(picks).toHaveLength(1);
  });
});
