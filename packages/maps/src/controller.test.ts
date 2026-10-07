// @vitest-environment jsdom
import { setActiveScene, type SceneHandle } from '@aio/engine';
import { createWorkspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (e: unknown) => void;

/** The slice of a MapLibre map the controller uses, recording listeners and removal. */
class FakeMap {
  static last: FakeMap | null = null;
  readonly handlers = new Map<string, Handler[]>();
  readonly canvas = document.createElement('canvas');
  readonly doubleClickZoom = { enable: vi.fn(), disable: vi.fn() };
  readonly remove = vi.fn(() => {
    this.handlers.clear();
  });
  sourceReads = 0;
  private readonly layers = new Set<string>();
  private readonly sources = new Set<string>();
  constructor() {
    FakeMap.last = this;
  }
  on(type: string, a: Handler | string, b?: Handler): void {
    const fn = typeof a === 'string' ? b : a;
    if (!fn) return;
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  once(type: string, fn: Handler): void {
    this.on(type, fn);
  }
  off(): void {
    /* not needed */
  }
  fire(type: string, e: unknown = {}): void {
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
  addControl(): void {
    /* controls draw nothing here */
  }
  addSource(id: string): void {
    this.sources.add(id);
  }
  getSource(id: string) {
    this.sourceReads++;
    return this.sources.has(id) ? { setData: () => Promise.resolve() } : undefined;
  }
  removeSource(id: string): void {
    this.sources.delete(id);
  }
  addLayer(l: { id: string }): void {
    this.layers.add(l.id);
  }
  getLayer(id: string) {
    return this.layers.has(id) ? { id } : undefined;
  }
  removeLayer(id: string): void {
    this.layers.delete(id);
  }
  setPaintProperty(): void {
    /* style only */
  }
  setLayoutProperty(): void {
    /* style only */
  }
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
  queryRenderedFeatures(): unknown[] {
    return [];
  }
  resize(): void {
    /* no layout in jsdom */
  }
}

/** A map control: nothing to draw here. */
class FakeControl {
  readonly kind = 'control';
}

vi.mock('maplibre-gl', () => ({
  Map: FakeMap,
  AttributionControl: FakeControl,
  NavigationControl: FakeControl,
  ScaleControl: FakeControl,
  Popup: class {
    remove = vi.fn();
    setLngLat() {
      return this;
    }
    setDOMContent() {
      return this;
    }
    addTo() {
      return this;
    }
  },
}));
// Vite-only asset and worker wiring.
vi.mock('./runtime', () => ({ installBasemap: vi.fn() }));

const { createMapController } = await import('./controller');

afterEach(() => {
  setActiveScene(null);
  vi.unstubAllGlobals();
});

function start() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const store = createWorkspace();
  const ctl = createMapController(el, { packs: [], store, showFlights: true });
  const map = FakeMap.last;
  if (!map) throw new Error('no map');
  map.fire('load');
  return { el, store, ctl, map };
}

describe('map controller dispose (T8 soak: maps kept alive after a project closed)', () => {
  it('removes the map and lets go of the workspace, the 3D view and its container', () => {
    const offFrame = vi.fn();
    const onFrame = vi.fn(() => offFrame);
    const scene = { onFrame, camera: null } as unknown as SceneHandle;
    setActiveScene(null);
    const { el, store, ctl, map } = start();
    // the controller follows the active 3D view for its camera wedge
    setActiveScene(scene);
    expect(onFrame).toHaveBeenCalled();
    expect((el as unknown as { __aioMap?: unknown }).__aioMap).toBe(map);

    ctl.dispose();
    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(offFrame).toHaveBeenCalled();
    expect('__aioMap' in el).toBe(false);

    // workspace changes and a new 3D view no longer reach the disposed map
    const reads = map.sourceReads;
    store.setState({ issues: [], selection: null, nowMs: 1 });
    const nextFrame = vi.fn(() => vi.fn());
    setActiveScene({ onFrame: nextFrame, camera: null } as unknown as SceneHandle);
    expect(nextFrame).not.toHaveBeenCalled();
    expect(map.sourceReads).toBe(reads);

    // a second dispose (React strict effects, a late cleanup) does nothing
    ctl.dispose();
    expect(map.remove).toHaveBeenCalledTimes(1);
  });

  it('cancels a hover redraw that waits for the next frame', () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 42),
    );
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const { ctl, map } = start();
    map.fire('mousemove', { point: { x: 1, y: 1 }, lngLat: { lng: 0, lat: 0 } });
    ctl.dispose();
    expect(cancel).toHaveBeenCalledWith(42);
  });
});
