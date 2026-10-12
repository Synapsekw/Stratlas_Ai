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
  jumpTo(): void {
    /* the camera is not drawn here */
  }
  fitBounds(): void {
    /* the camera is not drawn here */
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
const geo = await import('./geo');

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

describe('map point pick (placing a walk on the map)', () => {
  /** A map with a UTM project open, so clicks have a local point. */
  function startWithProject() {
    const started = start();
    const { frameProjection } = geo;
    const manifest = {
      crs: { epsg: 32633 },
      origin: [500_000, 4_000_000, 0],
      layers: [],
    };
    started.store.setState({
      project: { id: 'p1', manifest } as unknown as ReturnType<
        typeof started.store.getState
      >['project'],
    });
    const proj = frameProjection({ epsg: 32633 }, [500_000, 4_000_000, 0]);
    if (!proj) throw new Error('no projection');
    return { ...started, proj };
  }
  const click = (lng: number, lat: number) => ({
    point: { x: 10, y: 10 },
    lngLat: { lng, lat },
    originalEvent: { clientX: 10, clientY: 10, altKey: false },
  });

  it('map pick returns the local point of the click and disarms', () => {
    const { ctl, map, proj, store } = startWithProject();
    const [lng, lat] = proj.toLonLat([12, 0, -34]);
    const onPick = vi.fn();
    ctl.pickPoint(onPick);
    expect(map.canvas.style.cursor).toBe('crosshair');
    const select = vi.spyOn(store.getState(), 'select');
    map.fire('click', click(lng, lat));
    expect(onPick).toHaveBeenCalledTimes(1);
    const local = onPick.mock.calls[0]?.[0] as [number, number, number];
    expect(local[0]).toBeCloseTo(12, 3);
    expect(local[2]).toBeCloseTo(-34, 3);
    expect(select).not.toHaveBeenCalled();
    expect(map.canvas.style.cursor).toBe('');
    // disarmed: the next click is an ordinary one
    map.fire('click', click(lng, lat));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels the pick, and the returned function disarms it', () => {
    const { ctl, map, proj } = startWithProject();
    const [lng, lat] = proj.toLonLat([1, 0, 1]);
    const onPick = vi.fn();
    const onCancel = vi.fn();
    ctl.pickPoint(onPick, onCancel);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(map.canvas.style.cursor).toBe('');
    map.fire('click', click(lng, lat));
    expect(onPick).not.toHaveBeenCalled();

    const disarm = ctl.pickPoint(onPick, onCancel);
    disarm();
    map.fire('click', click(lng, lat));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
